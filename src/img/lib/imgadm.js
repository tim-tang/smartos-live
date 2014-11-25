/*
 * CDDL HEADER START
 *
 * The contents of this file are subject to the terms of the
 * Common Development and Distribution License, Version 1.0 only
 * (the "License").  You may not use this file except in compliance
 * with the License.
 *
 * You can obtain a copy of the license at http://smartos.org/CDDL
 *
 * See the License for the specific language governing permissions
 * and limitations under the License.
 *
 * When distributing Covered Code, include this CDDL HEADER in each
 * file.
 *
 * If applicable, add the following below this CDDL HEADER, with the
 * fields enclosed by brackets "[]" replaced with your own identifying
 * information: Portions Copyright [yyyy] [name of copyright owner]
 *
 * CDDL HEADER END
 *
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * * *
 * The main imgadm functionality. The CLI is a light wrapper around this tool.
 *
 *      var imgadm = require('./imgadm');
 *      var bunyan = require('bunyan');
 *      var log = bunyan.createLogger({name: 'foo'});
 *      imgadm.createTool({log: log}, function (err, tool) {
 *
 *          tool.listImages(function (err, images) { ... });
 *          // ...
 *
 *      });
 */

var p = console.warn;

var assert = require('assert-plus');
var async = require('async');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;
var crypto = require('crypto');
var dsapi = require('sdc-clients/lib/dsapi');
var findit = require('findit');
var fs = require('fs');
var genUuid = require('node-uuid');
var imgapi = require('sdc-clients/lib/imgapi');
var imgmanifest = require('imgmanifest');
var lock = require('/usr/img/node_modules/locker').lock;
var mkdirp = require('mkdirp');
var once = require('once');
var path = require('path');
var ProgressBar = require('progbar').ProgressBar;
var rimraf = require('rimraf');
var url = require('url');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var zfs = require('/usr/node/node_modules/zfs.js').zfs;

var common = require('./common'),
    NAME = common.NAME,
    objCopy = common.objCopy,
    assertUuid = common.assertUuid,
    execFilePlus = common.execFilePlus;
var docker = require('./apis/docker');
var errors = require('./errors');
var upgrade = require('./upgrade');



// ---- globals

var DB_DIR = '/var/imgadm';
var CONFIG_PATH = DB_DIR + '/imgadm.conf';
var DEFAULT_CONFIG = {};

/* BEGIN JSSTYLED */
var VMADM_FS_NAME_RE = /^([a-zA-Z][a-zA-Z\._-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(-disk\d+)?$/;
var VMADM_IMG_NAME_RE = /^([a-zA-Z][a-zA-Z\._-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/* END JSSTYLED */

var UA = 'imgadm/' + common.getVersion()
    + ' (' + 'node/' + process.versions.node + '; '
    + 'OpenSSL/' + process.versions.openssl + ')';



// ---- internal support stuff

function _indent(s, indent) {
    if (!indent) indent = '    ';
    var lines = s.split(/\r?\n/g);
    return indent + lines.join('\n' + indent);
}


function getSysinfo(log, callback) {
    assert.object(log, 'log');
    assert.func(callback, 'callback');
    exec('sysinfo', function (err, stdout, stderr) {
        if (err) {
            callback(err);
        } else {
            // Explicitly want to abort/coredump on this not being parsable.
            var sysinfo = JSON.parse(stdout.trim());
            callback(null, sysinfo);
        }
    });
}

/**
 * Call `zfs destroy -r` on the given dataset name.
 *
 * TODO: use zfs.js (OS-1919).
 */
function zfsDestroy(dataset, log, callback) {
    assert.string(dataset, 'dataset');
    assert.object(log, 'log');
    assert.func(callback, 'callback');
    var cmd = format('/usr/sbin/zfs destroy -r %s', dataset);
    exec(cmd, function (err, stdout, stderr) {
        log.trace({cmd: cmd, err: err, stdout: stdout, stderr: stderr},
            'zfsDestroy');
        callback(err);
    });
}

/**
 * Call `zfs rename -r SNAPSHOT SNAPSHOT`.
 *
 * @param a {String} The current snapshot name.
 * @param b {String} The snapshot name to which to rename.
 * @param options {Object}
 *      - recursive {Boolean} Optional. Use '-r' arg to 'zfs rename'.
 *      - log {Bunyan Logger}
 * @param callback {Function} `function (err)`
 */
function zfsRenameSnapshot(a, b, options, callback) {
    assert.string(a, 'a');
    assert.string(b, 'b');
    assert.object(options, 'options');
    assert.optionalBool(options.recursive, 'options.recursive');
    assert.object(options.log, 'options.log');
    assert.func(callback);
    var optStr = '';
    if (options.recursive) {
        optStr += ' -r';
    }
    var cmd = format('/usr/sbin/zfs rename%s %s', optStr, a, b);
    options.log.trace({cmd: cmd}, 'start zfsRenameSnapshot');
    exec(cmd, function (err, stdout, stderr) {
        options.log.trace({cmd: cmd, err: err, stdout: stdout, stderr: stderr},
            'finish zfsRenameSnapshot');
        callback(err);
    });
}

/**
 * Get details on a ZFS dataset.
 *
 * @param name {String} The zfs dataset name, "$pool/$uuid".
 * @param properties {Array} Optional array of property names to get.
 *      "name" is always included. "children" is special: it does extra work
 *      to gather the list of child snapshots and dependent clones.
 * @param callback {Function} `function (err, dataset)`
 *      Returns `callback(null, null)` if the dataset name doesn't exist.
 *
 * TODO: use zfs.js (OS-1919).
 */
function getZfsDataset(name, properties, callback) {
    assert.string(name, 'name');
    if (callback === undefined) {
        callback = properties;
        properties = [];
    }
    assert.arrayOfString(properties, 'properties');

    if (properties.indexOf('name') === -1) {
        properties.push('name');
    }
    var cIdx = properties.indexOf('children');
    if (cIdx !== -1) {
        properties.splice(cIdx);
    }
    var dataset;

    function getDataset(next) {
        var cmd = format('/usr/sbin/zfs list -H -p -o %s %s',
            properties.join(','), name);
        exec(cmd, function (err, stdout, stderr) {
            if (err) {
                // `zfs list` *seems* to exit 2 for bogus properties and 1 for
                // non-existant dataset.
                if (err.code === 1) {
                    dataset = null;
                    next();
                    return;
                } else {
                    next(new errors.InternalError({
                        cause: err,
                        message: format('error running "%s": %s', cmd,
                            stderr.split('\n', 1)[0])
                    }));
                    return;
                }
            }
            var values = stdout.trim().split('\t');
            dataset = {};
            for (var i = 0; i < properties.length; i++) {
                dataset[properties[i]] = values[i] === '-' ? null : values[i];
            }
            next();
        });
    }

    function getChildSnapshots(next) {
        if (!dataset) {
            next();
            return;
        }
        dataset.children = {};
        var cmd = format('/usr/sbin/zfs list -t all -pHr -o name %s', name);
        exec(cmd, function (err, stdout, stderr) {
            if (err) {
                next(new errors.InternalError({
                    cause: err,
                    message: format('error running "%s": %s', cmd,
                        stderr.split('\n', 1)[0])
                }));
                return;
            }
            dataset.children.snapshots = stdout.trim().split(/\n/g).slice(1);
            next();
        });
    }

    /**
     * Dependent clones of a dataset are zfs filesystems or volumes
     * (-t filesystem,volume)
     * created by `zfs clone` of a snapshot of the dataset in question.
     * This snapshot is the `origin` property of that clone. A snapshot
     * is named <dataset>@<snapshot-name>. Hence we can get a list via:
     *
     *      zfs list -t filesystem,volume -o origin,name -pH | grep '^NAME@'
     *
     * where 'NAME' is the dataset name.
     */
    function getDependentClones(next) {
        if (!dataset) {
            next();
            return;
        }
        var cmd = '/usr/sbin/zfs list -t filesystem,volume -o origin,name -pH';
        exec(cmd, function (err, stdout, stderr) {
            if (err) {
                next(new errors.InternalError({
                    cause: err,
                    message: format('error running "%s": %s', cmd, stderr)
                }));
                return;
            }
            var clones = dataset.children.clones = [];
            var lines = stdout.trim().split(/\n/g);
            var marker = name + '@';
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (line.slice(0, marker.length) !== marker)
                    continue;
                clones.push(line.split(/\t/g)[1]);
            }
            next();
        });
    }

    var funcs = [getDataset];
    if (cIdx !== -1) {
        funcs.push(getChildSnapshots);
        funcs.push(getDependentClones);
    }
    async.waterfall(funcs, function (err) {
        callback(err, dataset);
    });
}


// TODO: persist "?channel=<channel>"
function normUrlFromUrl(u) {
    // `url.parse('example.com:9999')` is not what you expect. Make sure we
    // have a protocol.
    if (! /^\w+:\/\// .test(u)) {
        u = 'http://' + u;
    }

    var parsed = url.parse(u);

    // Don't want trailing '/'.
    if (parsed.pathname.slice(-1) === '/') {
        parsed.pathname = parsed.pathname.slice(0, -1);
    }

    // Drop redundant ports.
    if (parsed.port
        && ((parsed.protocol === 'https:' && parsed.port === '443')
        || (parsed.protocol === 'http:' && parsed.port === '80'))) {
        parsed.port = '';
        parsed.host = parsed.hostname;
    }

    return url.format(parsed);
}



// ---- Source class

/**
 * A light wrapper around an image source repository.
 *
 * @param options {Object} with these keys
 *      - url {String}
 *      - type {String} One of `common.VALID_SOURCE_TYPES`.
 *      - log {Bunyan Logger}
 */
function Source(options) {
    assert.object(options, 'options');
    assert.string(options.url, 'options.url');
    assert.string(options.type, 'options.type');
    assert.object(options.log, 'options.log');
    this.url = options.url;
    this.type = options.type;
    this.normUrl = normUrlFromUrl(this.url);
    this.log = options.log;
}



// ---- IMGADM tool

function IMGADM(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    this.log = options.log;
    this._manifestFromUuid = null;
    this.sources = null;
}

IMGADM.prototype.init = function init(callback) {
    var self = this;

    function loadConfig(next) {
        self.config = objCopy(DEFAULT_CONFIG);
        fs.exists(CONFIG_PATH, function (exists) {
            if (!exists) {
                next();
                return;
            }
            self.log.trace({path: CONFIG_PATH}, 'read config file');
            fs.readFile(CONFIG_PATH, 'utf8', function (err, content) {
                try {
                    var config = JSON.parse(content);
                } catch (e) {
                    next(new errors.ConfigError(e, format(
                        'config file "%s" is not valid JSON', CONFIG_PATH)));
                    return;
                }
                Object.keys(config).forEach(function (k) {
                    self.config[k] = config[k];
                });
                next();
            });
        });
    }

    function setUserAgent(next) {
        self.userAgent = UA;
        if (self.config && self.config.userAgentExtra) {
            if (typeof (self.config.userAgentExtra) !== 'string') {
                next(new errors.ConfigError(format(
                    '"userAgentExtra" in config file "%s" is not a string',
                    CONFIG_PATH)));
                return;
            }
            self.userAgent += ' ' + self.config.userAgentExtra;
        }
        next();
    }

    function upgradeDb(next) {
        upgrade.upgradeIfNecessary(self, next);
    }

    function addSources(next) {
        self.sources = [];
        var sources = self.config.sources || [common.DEFAULT_SOURCE];
        self.log.trace({sources: sources}, 'init: add sources');
        async.forEachSeries(
            sources,
            function oneSource(source, nextSource) {
                self._addSource(source, true, nextSource);
            },
            function doneSources(err) {
                if (err) {
                    next(err);
                    return;
                }
                next();
            }
        );
    }

    async.series([
        loadConfig,
        setUserAgent,
        upgradeDb,
        addSources
    ], callback);
};


/**
 * Add a source URL to the current IMGADM object. It normalizes and handles
 * DNS lookup as required.
 *
 * Note that this does *not* update the IMGADM config file.
 *
 * @param source {Source|Object} A `Source` instance or an object describing
 *      the image source with these keys:
 *      - url {String}
 *      - type {String}
 * @param skipPingCheck {Boolean} Whether to do a ping check on the new
 *      source URL. This is done to (a) verify that the given URL doesn't have
 *      typos and (b) to determine which type of source it is if `type` isn't
 *      specified. By default the ping check is done when adding a source
 *      (unless it is an existing source, i.e. if `source` is already a `Source`
 *      instance). If `source.type` is not given, then the ping check cannot be
 *      skipped.
 * @param callback {Function} `function (err, changed)` where `changed` is
 *      a boolean indicating if the config changed as a result.
 */
IMGADM.prototype._addSource = function _addSource(
        source, skipPingCheck, callback) {
    assert.object(source, 'source');
    assert.string(source.url, 'source.url');
    assert.string(source.type, 'source.type');
    assert.bool(skipPingCheck, 'skipPingCheck');
    assert.func(callback, 'callback');
    var self = this;

    // Ping-test against the new URL
    function sourcePingCheck(sourceToPing, next) {
        if (skipPingCheck) {
            next();
            return;
        }

        self.log.trace({source: sourceToPing.url}, 'sourcePingCheck');
        self.clientFromSource(sourceToPing, function (cErr, client) {
            if (cErr) {
                next(cErr);
                return;
            }
            client.ping(function (err, pong, res) {
                if (err
                    || res.statusCode !== 200
                    || (sourceToPing.type === 'imgapi' && !pong.imgapi))
                {
                    if (res
                        && res.headers['content-type'] !== 'application/json')
                    {
                        var body = res.body;
                        if (body && body.length > 1024) {
                            body = body.slice(0, 1024) + '...';
                        }
                        err = new Error(format(
                            'statusCode %s, response not JSON:\n%s',
                            res.statusCode, _indent(body)));
                    }
                    next(new errors.SourcePingError(err, sourceToPing));
                    return;
                }
                next();
            });
        });
    }

    // No-op if already have this URL/TYPE.
    var normUrl = normUrlFromUrl(source.url);
    for (var i = 0; i < self.sources.length; i++) {
        if (self.sources[i].normUrl === normUrl
            && self.sources[i].type === source.type)
        {
            return callback(null, false);
        }
    }

    // If already a source, then just add it.
    if (source.constructor.name === 'Source') {
        self.sources.push(source);
        callback(null, true);
        return;
    }

    // Else make a new Source instance.
    var s = new Source({url: source.url, type: source.type, log: self.log});
    if (skipPingCheck) {
        self.sources.push(s);
        callback(null, true);
    } else {
        sourcePingCheck(s, function (pingErr) {
            if (pingErr) {
                callback(pingErr);
                return;
            }
            self.sources.push(s);
            callback(null, true);
        });
    }
};


/**
 * Remove a source from the current IMGADM object.
 *
 * Note that this does *not* update the IMGADM config file.
 *
 * @param sourceUrl {String}
 * @param callback {Function} `function (err, deleted)` where `deleted` is
 *      an array of `Source` instances deleted, if any.
 */
IMGADM.prototype._delSource = function _delSource(sourceUrl, callback) {
    assert.string(sourceUrl, 'sourceUrl');
    var normSourceUrl = normUrlFromUrl(sourceUrl);
    var deleted = [];
    this.sources = this.sources.filter(function (s) {
        if (s.normUrl !== normSourceUrl) {
            return true;
        } else {
            deleted.push(s);
            return false;
        }
    });
    callback(null, deleted.length ? deleted : null);
};


/**
 * Add a source and update the on-disk config.
 *
 * @param source {Object} Image source object with these keys:
 *      - url {String}
 *      - type {String} Optional. One of 'imgapi', 'docker', or 'dsapi'. If
 *        not given it is (imperfectly) inferred from the URL.
 * @param skipPingCheck {Boolean} Whether to do a ping check on the new
 *      source URL. Default false.
 * @param callback {Function} `function (err, changed)`
 */
IMGADM.prototype.configAddSource = function configAddSource(
        source, skipPingCheck, callback) {
    assert.object(source, 'source');
    assert.string(source.url, 'source.url');
    assert.optionalString(source.type, 'source.type');
    assert.bool(skipPingCheck, 'skipPingCheck');
    assert.func(callback, 'callback');
    var self = this;

    self._addSource(source, skipPingCheck, function (addErr, changed) {
        if (addErr) {
            callback(addErr);
        } else if (changed) {
            if (!self.config.sources) {
                // Was implicitly getting the default source. Let's keep it.
                self.config.sources = [common.DEFAULT_SOURCE];
            }
            self.config.sources.push({url: source.url, type: source.type});
            self.saveConfig(function (saveErr) {
                if (saveErr) {
                    callback(saveErr);
                    return;
                }
                self.log.debug({source: source}, 'added source url');
                callback(null, true);
            });
        } else {
            callback(null, false);
        }
    });
};


/**
 * Delete a source URL and update the on-disk config.
 *
 * @param sourceUrl {String}
 * @param callback {Function} `function (err, deleted)` where `deleted` is
 *      an array of `Source` instances deleted, if any.
 */
IMGADM.prototype.configDelSourceUrl = function configDelSourceUrl(
        sourceUrl, callback) {
    assert.string(sourceUrl, 'sourceUrl');
    var self = this;

    self._delSource(sourceUrl, function (delErr, deleted) {
        if (delErr) {
            callback(delErr);
        } else if (deleted) {
            self.config.sources = self.sources.map(function (s) {
                return {url: s.url, type: s.type};
            });
            self.saveConfig(function (saveErr) {
                if (saveErr) {
                    callback(saveErr);
                    return;
                }
                self.log.debug({sourceUrl: sourceUrl}, 'deleted source url');
                callback(null, deleted);
            });
        } else {
            callback(null, null);
        }
    });
};


/**
 * Update sources with the given URLs.
 *
 * Dev Notes: The histrionics below are to avoid re-running ping checks
 * on already existing source URLs.
 *
 * @param sourcesInfo {Array} Array of source info objects (with type and
 *      url keys).
 * @param skipPingCheck {Boolean} Whether to do a ping check on the new
 *      source URL. Default false. However, a ping check is not done
 *      on already existing sources.
 * @param callback {Function} `function (err, changes)` where `changes` is
 *      a list of changes of the form `{type: <type>, url: <url>}` where
 *      `type` is one of 'reorder', 'add', 'del'.
 */
IMGADM.prototype.updateSources = function updateSources(
        sourcesInfo, skipPingCheck, callback) {
    assert.arrayOfObject(sourcesInfo, 'sourcesInfo');
    assert.bool(skipPingCheck, 'skipPingCheck');
    assert.func(callback, 'callback');
    var self = this;
    var i, j;

    // Validate types
    for (i = 0; i < sourcesInfo.length; i++) {
        var si = sourcesInfo[i];
        assert.string(si.url, format('sourcesInfo[%d].url', i));
        assert.string(si.type, format('sourcesInfo[%d].type', i));
        if (common.VALID_SOURCE_TYPES.indexOf(si.type) === -1) {
            callback(new errors.ConfigError(format(
                'type "%s" for source url "%s" is invalid: must be one of "%s"',
                si.type, si.url, common.VALID_SOURCE_TYPES.join('", "'))));
        }
    }

    var changes = [];
    var oldSources = self.sources.map(function (s) {
        return {url: s.url, type: s.type};
    });
    var newSources = [];
    for (i = 0; i < sourcesInfo.length; i++) {
        var sourceInfo = sourcesInfo[i];
        var idx = -1;
        for (j = 0; j < oldSources.length; j++) {
            var old = oldSources[j];
            if (old && old.type === sourceInfo.type
                && old.url === sourceInfo.url)
            {
                idx = j;
                break;
            }
        }
        if (idx === -1) {
            newSources.push(sourceInfo);
            changes.push({type: 'add', source: sourceInfo});
        } else {
            newSources.push(self.sources[idx]);
            oldSources[idx] = null;
        }
    }
    oldSources
        .filter(function (s) { return s !== null; })
        .forEach(function (s) { changes.push({type: 'del', source: s}); });
    if (changes.length === 0) {
        changes.push({type: 'reorder'});
    }

    self.sources = [];
    async.forEachSeries(
        newSources,
        function oneSource(s, next) {
            self._addSource(s, skipPingCheck, next);
        },
        function doneSources(err) {
            if (err) {
                callback(err);
                return;
            }
            self.config.sources = self.sources.map(
                function (s) { return {url: s.url, type: s.type}; });
            self.saveConfig(function (saveErr) {
                if (saveErr) {
                    callback(saveErr);
                    return;
                }
                callback(null, changes);
            });
        }
    );
};


/**
 * Save out the current config.
 *
 * @param callback {Function} `function (err)`
 */
IMGADM.prototype.saveConfig = function saveConfig(callback) {
    var self = this;
    self.log.debug({config: self.config}, 'save config to %s', CONFIG_PATH);
    var configDir = path.dirname(CONFIG_PATH);
    mkdirp(configDir, function (dirErr) {
        if (dirErr) {
            callback(dirErr);
            return;
        }
        var str = JSON.stringify(self.config, null, 2);
        fs.writeFile(CONFIG_PATH, str, 'utf8', callback);
    });
};



/**
 * Return an API client for the given source.
 *
 * @param source {Source}
 * @param callback {Function} `function (err, client)`
 */
IMGADM.prototype.clientFromSource = function clientFromSource(
        source, callback) {
    var self = this;
    assert.object(source, 'source');
    assert.func(callback, 'callback');

    if (self._clientCache === undefined) {
        self._clientCache = {};
    }
    var client = self._clientCache[source.normUrl];
    if (client) {
        callback(null, client);
        return;
    }

    var normUrl = source.normUrl;
    if (source.type === 'dsapi') {
        if (! /\/datasets\/?$/.test(normUrl)) {
            callback(new errors.ConfigError(format(
                '"dsapi" source URL does not end with "/datasets": "%s"',
                normUrl)));
            return;
        }
        var baseNormUrl = path.dirname(normUrl); // drop 'datasets/' tail
        self._clientCache[normUrl] = dsapi.createClient({
            agent: false,
            url: baseNormUrl,
            log: self.log.child({component: 'api', source: source.url}, true),
            rejectUnauthorized: (process.env.IMGADM_INSECURE !== '1'),
            userAgent: self.userAgent
        });
    } else if (source.type === 'imgapi') {
        self._clientCache[normUrl] = imgapi.createClient({
            agent: false,
            url: normUrl,
            version: '~2',
            log: self.log.child({component: 'api', source: source.url}, true),
            rejectUnauthorized: (process.env.IMGADM_INSECURE !== '1'),
            userAgent: self.userAgent
        });
    } else if (source.type === 'docker') {
        self._clientCache[normUrl] = docker.createClient({
            agent: false,
            url: normUrl,
            log: self.log.child({component: 'api', source: source.url}, true),
            rejectUnauthorized: (process.env.IMGADM_INSECURE !== '1'),
            userAgent: self.userAgent
        });
    } else {
        throw new Error('unknown source type: "' + source.type + '"');
    }
    callback(null, self._clientCache[normUrl]);
};


IMGADM.prototype._errorFromClientError = function _errorFromClientError(
        clientUrl, err) {
    assert.string(clientUrl, 'clientUrl');
    assert.object(err, 'err');
    if (err.body && err.body.code) {
        return new errors.APIError(clientUrl, err);
    } else if (err.errno) {
        return new errors.ClientError(clientUrl, err);
    } else {
        return new errors.InternalError({message: err.message,
            clientUrl: clientUrl, cause: err});
    }
};



IMGADM.prototype._dbImagePath = function _dbImagePath(zpool, uuid) {
    return path.resolve(DB_DIR, 'images', zpool + '-' + uuid + '.json');
};


/**
 * Load the image info for this image from the imgadm db.
 *
 * This never callsback with an error. Basically we treat the imgadm db
 * of image info as a cache: if we don't have the manifest info, then we
 * keep going. A debug message is logged if there is a corrupt db file that
 * is ignored.
 *
 * If no image info is found in the db, then this returns the minimal
 * `imageInfo`:  `{manifest: {uuid: UUID}, zpool: ZPOOL}`
 *
 * @param options {Object}:
 *      - @param uuid {String}
 *      - @param zpool {String}
 * @param callback {Function} `function (err, imageInfo)`
 */
IMGADM.prototype._dbLoadImage = function _dbLoadImage(options, callback) {
    var self = this;
    assert.object(options, 'options');
    assertUuid(options.uuid, 'options.uuid');
    assert.string(options.zpool, 'options.zpool');
    assert.func(callback, 'callback');

    var dbImagePath = this._dbImagePath(options.zpool, options.uuid);
    fs.readFile(dbImagePath, 'utf8', function (err, content) {
        var info = null;
        if (!err) {
            try {
                info = JSON.parse(content);
            } catch (synErr) {
                self.log.debug(synErr, 'corrupt "%s"', dbImagePath);
            }
            assert.equal(info.manifest.uuid, options.uuid, format(
                'UUID for image in "%s" is wrong', dbImagePath));
        }
        if (!info) {
            info = {manifest: {uuid: options.uuid}, zpool: options.zpool};
        }
        callback(null, info);
    });
};


/**
 * Delete image info for this image from the imgadm db.
 *
 * @param options {Object}:
 *      - @param uuid {String}
 *      - @param zpool {String}
 * @param callback {Function} `function (err)`  It is *not* an error if the
 *      db image file does not exist (imgadm supports handling images that
 *      aren't in the imgadm db).
 */
IMGADM.prototype._dbDeleteImage = function _dbDeleteImage(options, callback) {
    assert.object(options, 'options');
    assertUuid(options.uuid, 'options.uuid');
    assert.string(options.zpool, 'options.zpool');
    assert.func(callback, 'callback');

    var dbImagePath = this._dbImagePath(options.zpool, options.uuid);
    fs.exists(dbImagePath, function (exists) {
        if (!exists) {
            callback();
            return;
        } else {
            fs.unlink(dbImagePath, callback);
        }
    });
};


/**
 * Save image info to the db.
 *
 * @param imageInfo {Object} Holds image details, with keys:
 *      - manifest {Object}
 *      - zpool {String} The zpool on which the image is installed.
 *      - source {String} The source object.
 * @param callback {Function} `function (err)`
 */
IMGADM.prototype.dbAddImage = function dbAddImage(imageInfo, callback) {
    assert.object(imageInfo, 'imageInfo');
    assert.object(imageInfo.manifest, 'imageInfo.manifest');
    assert.string(imageInfo.zpool, 'imageInfo.zpool');
    assert.optionalObject(imageInfo.source, 'imageInfo.source');

    var dbImagePath = this._dbImagePath(imageInfo.zpool,
                                        imageInfo.manifest.uuid);
    var dbImageDir = path.dirname(dbImagePath);
    mkdirp(dbImageDir, function (dirErr) {
        if (dirErr) {
            callback(dirErr);
            return;
        }
        var dbData = {
            manifest: imageInfo.manifest,
            zpool: imageInfo.zpool,
            source: (imageInfo.source ? imageInfo.source.url : undefined)
        };
        var content = JSON.stringify(dbData, null, 2) + '\n';
        fs.writeFile(dbImagePath, content, 'utf8', callback);
    });
};


/**
 * Load images from the system and merge in manifest data from the imgadm
 * cache/database.
 *
 * @param callback {Function} `function (err, imagesInfo)`
 */
IMGADM.prototype._loadImages = function _loadImages(callback) {
    var self = this;
    var i;

    // Get a list of provisionable images. Here 'provisionable' means that
    // we are also constrained by 'vmadm create' rules. That means a
    // zfs "filesystem" (for zones) or "volume" (for KVM VMs) named
    // "$zpoolname/$uuid" whose mountpoint is not a zone root. Full images
    // won't have an origin, incremental images will.
    //
    // These conditions can conceivably include non-images: any clone not a
    // zone and named "ZPOOL/UUID". For this reason, any zfs dataset with
    // the property imgadm:ignore=true will be excluded, as an out.
    //
    // If necessary we could consider only include those with an origin
    // (i.e. incremental images) that also have a "@final" snapshot, as
    // recent imgadm guarantees on import.
    //
    // We also count the usages of these images: zfs filesystems with the
    // image as an origin.

    var zCmd = '/usr/sbin/zoneadm list -pc';
    /* BEGIN JSSTYLED */
    // Example output:
    //      0:global:running:/::liveimg:shared:
    //      ...
    //      21:dc5cbce7-798a-4bc8-bdc5-61b4be00a22e:running:/zones/dc5cbce7-798a-4bc8-bdc5-61b4be00a22e:dc5cbce7-798a-4bc8-bdc5-61b4be00a22e:joyent-minimal:excl:21
    //      -:7970c690-1738-4e58-a04f-8ce4ea8ebfca:installed:/zones/7970c690-1738-4e58-a04f-8ce4ea8ebfca:7970c690-1738-4e58-a04f-8ce4ea8ebfca:kvm:excl:22
    /* END JSSTYLED */
    exec(zCmd, function (zError, zStdout, zStderr) {
        if (zError) {
            callback(new errors.InternalError(
                {message: format('could not list zones: %s', zError)}));
            return;
        }
        var zLines = zStdout.trim().split('\n');
        var zoneRoots = {};
        zLines.forEach(function (zLine) {
            var zoneRoot = zLine.split(/:/g)[3];
            zoneRoots[zoneRoot] = true;
        });

        var cmd = '/usr/sbin/zfs list -t filesystem,volume -pH '
            + '-o name,origin,mountpoint,imgadm:ignore';
        exec(cmd, function (error, stdout, stderr) {
            if (error) {
                callback(new errors.InternalError(
                    {message: format('could not load images: %s', error)}));
                return;
            }
            var lines = stdout.trim().split('\n');
            var imageNames = [];
            var usageFromImageName = {};
            for (i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line.length === 0)
                    continue;
                var parts = line.split('\t');
                assert.equal(parts.length, 4);
                var name = parts[0];
                var origin = parts[1];
                var mountpoint = parts[2];
                var ignore = parts[3];
                if (!VMADM_FS_NAME_RE.test(name))
                    continue;
                if (// If it has a mountpoint from `zoneadm list` it is
                    // a zone, not an image.
                    !zoneRoots[mountpoint]
                    // If it doesn't match `VMADM_IMG_NAME_RE` it is
                    // a KVM disk volume, e.g.
                    // "zones/7970c690-1738-4e58-a04f-8ce4ea8ebfca-disk0".
                    && VMADM_IMG_NAME_RE.test(name))
                {
                    // Gracefully handle 'imgadm:ignore' boolean property.
                    if (ignore !== '-') {
                        try {
                            ignore = common.boolFromString(ignore, false,
                                '"imgadm:ignore" zfs property');
                        } catch (e) {
                            self.log.warn('dataset %s: %s', name, e);
                            ignore = false;
                        }
                    } else {
                        ignore = false;
                    }
                    if (!ignore) {
                        imageNames.push(name);
                    }
                }
                if (origin !== '-') {
                    // This *may* be a filesystem using an image. See
                    // joyent/smartos-live#180 for a counter-example.
                    name = origin.split('@')[0];
                    if (usageFromImageName[name] === undefined) {
                        usageFromImageName[name] = 1;
                    } else {
                        usageFromImageName[name]++;
                    }
                }
            }

            var imagesInfo = [];
            async.forEachSeries(
                imageNames,
                function loadOne(imageName, next) {
                    var parsed = VMADM_FS_NAME_RE.exec(imageName);
                    var opts = {uuid: parsed[2], zpool: parsed[1]};
                    self._dbLoadImage(opts, function (err, info) {
                        if (err) {
                            next(err);
                            return;
                        }
                        info.clones = usageFromImageName[imageName] || 0;
                        imagesInfo.push(info);
                        next();
                    });
                },
                function doneLoading(err) {
                    if (err) {
                        callback(err);
                    } else {
                        callback(null, imagesInfo);
                    }
                }
            );
        });
    });
};


/**
 * Load info on the given locally installed image uuid.
 *
 * We don't just load "$uuid.json" from the imgadm db, because there might
 * be zombies (i.e. if the image was destroyed behind imgadm's back).
 *
 * @param options {Object} with:
 *      - @param uuid {String}
 *      - @param zpool {String}
 *      - @param children {Boolean} Optional. Set to true to also gather a
 *          list of child snapshots and dependent clones. Default is false.
 * @param callback {Function} `function (err, imageInfo)`
 *      If the image is not found it does `callback(null, null)`.
 */
IMGADM.prototype.getImage = function getImage(options, callback) {
    assert.object(options, 'options');
    assertUuid(options.uuid, 'options.uuid');
    assert.string(options.zpool, 'options.zpool');
    assert.optionalBool(options.children, 'options.children');
    assert.func(callback, 'callback');
    var self = this;

    var name = format('%s/%s', options.zpool, options.uuid);
    var properties = ['name'];
    if (options.children) {
        properties.push('children');
    }
    getZfsDataset(name, properties, function (zfsErr, dataset) {
        if (zfsErr) {
            callback(zfsErr);
            return;
        } else if (!dataset) {
            callback(null, null);
            return;
        }
        self._dbLoadImage(options, function (loadErr, info) {
            if (loadErr) {
                callback(loadErr);
                return;
            }
            if (options.children) {
                info.children = dataset.children;
            }
            callback(null, info);
        });
    });
};



/**
 * Return available images from all sources.
 *
 * @param callback {Function} `function (err, imagesInfo)`
 *      If there is an error then `err` will be set. Note that `imagesInfo`
 *      will still contain results. This is so that an error in one source
 *      does not break everything.
 */
IMGADM.prototype.sourcesList = function sourcesList(callback) {
    var self = this;
    var errs = [];
    var imageSetFromSourceUrl = {};

    if (self.sources.length === 0) {
        callback(new errors.NoSourcesError());
        return;
    }
    async.forEach(
        self.sources,
        function oneSource(source, next) {
            var limit, marker;
            var images = [];
            var stop = false;
            var client;

            self.clientFromSource(source, function (cErr, _client) {
                if (cErr) {
                    errs.push(cErr);
                    next();
                    return;
                }

                client = _client;
                async.doWhilst(listImagesFromSource,
                    function testAllImagesFetched() {
                        return !stop;
                    },
                    function doneOneSource(whilstErr) {
                        imageSetFromSourceUrl[source.url] = images;
                        return next();
                    }
                );
            });

            function listImagesFromSource(whilstNext) {
                var filterOpts = {};
                // These options are passed once they are set for the first time
                if (marker) {
                    filterOpts.marker = marker;
                }
                if (limit) {
                    filterOpts.limit = limit;
                }

                client.listImages(filterOpts, function (listErr, sImages, res) {
                    if (listErr) {
                        errs.push(self._errorFromClientError(
                            source.url, listErr));
                        stop = true;
                        return whilstNext();
                    }
                    // On every query we do this:
                    // - check if result size is less than limit (stop)
                    // - if we have to keep going set a new marker,
                    //   otherwise shift() because the first element is
                    //   our marker
                    // - concat to full list of images
                    if (!limit) {
                        limit = 1000;
                    }
                    if (sImages.length < limit) {
                        stop = true;
                    }
                    // No marker means this is the first query and we
                    // shouldn't shift() the array
                    if (marker) {
                        sImages.shift();
                    }
                    // We hit this when we either reached an empty page of
                    // results or an empty first result
                    if (!sImages.length) {
                        stop = true;
                        return whilstNext();
                    }
                    // Safety check if remote server doesn't support limit
                    // and marker yet. In this case we would be iterating
                    // over the same list of /images
                    var newMarker = sImages[sImages.length - 1].uuid;
                    if (marker && marker === newMarker) {
                        stop = true;
                        return whilstNext();
                    }
                    marker = newMarker;
                    images = images.concat(sImages);
                    return whilstNext();
                });
            }
        },
        function done(err) {
            if (!err && errs.length) {
                err = (errs.length === 1 ? errs[0]
                    : new errors.MultiError(errs));
            }
            var imagesInfo = [];
            var imageFromUuid = {};
            self.log.trace({imageSetFromSourceUrl: imageSetFromSourceUrl},
                'image sets from each source');
            for (var i = 0; i < self.sources.length; i++) {
                var sourceUrl = self.sources[i].url;
                var imageSet = imageSetFromSourceUrl[sourceUrl];
                if (!imageSet) {
                    continue;
                }
                for (var j = 0; j < imageSet.length; j++) {
                    var image = imageSet[j];
                    var uuid = image.uuid;
                    if (imageFromUuid[uuid] === undefined) {
                        imageFromUuid[uuid] = image;
                        imagesInfo.push({manifest: image, source: sourceUrl});
                    }
                }
            }
            callback(err, imagesInfo);
        }
    );
};


/**
 * Get info (mainly manifest data) on the given image UUID from sources.
 *
 * @param options {Object}
 *      - @param uuid {String} Required. The image UUID to get.
 *      - @param ensureActive {Boolean} Required. Set to true to skip inactive
 *        images.
 *      - @param sources {Array} Optional. An optional override to the set
 *        of sources to search. Defaults to `self.sources`.
 * @param callback {Function} `function (err, imageInfo)` where `imageInfo`
 *      is `{manifest: <manifest>, source: <source>}`
 */
IMGADM.prototype.sourcesGet = function sourcesGet(options, callback) {
    assert.object(options, 'options');
    assert.string(options.uuid, 'options.uuid');
    assert.bool(options.ensureActive, 'options.ensureActive');
    assert.optionalArrayOfObject(options.sources, 'options.sources');
    assert.func(callback, 'callback');
    var self = this;
    var uuid = options.uuid;
    var ensureActive = options.ensureActive;
    var errs = [];

    if (self.sources.length === 0) {
        callback(new errors.NoSourcesError());
        return;
    }

    var imageInfo = null;
    async.forEachSeries(
        options.sources || self.sources,
        function oneSource(source, next) {
            if (imageInfo) {
                next();
                return;
            }
            self.clientFromSource(source, function (cErr, client) {
                if (cErr) {
                    next(cErr);
                    return;
                }
                client.getImage(uuid, function (getErr, manifest) {
                    if (getErr && getErr.statusCode !== 404) {
                        errs.push(self._errorFromClientError(
                            source.url, getErr));
                        next();
                        return;
                    }
                    if (manifest) {
                        if (ensureActive) {
                            try {
                                manifest
                                    = imgmanifest.upgradeManifest(manifest);
                            } catch (err) {
                                errs.push(new errors.InvalidManifestError(err));
                                next();
                                return;
                            }
                        }
                        if (!ensureActive || manifest.state === 'active') {
                            imageInfo = {manifest: manifest, source: source};
                        }
                    }
                    next();
                });
            });
        },
        function done(err) {
            if (!err && errs.length) {
                err = (errs.length === 1 ? errs[0]
                    : new errors.MultiError(errs));
            }
            callback(err, imageInfo);
        }
    );
};


/**
 * Get info (mainly manifest data) on the given image UUID from sources.
 *
 * @param imageInfo {Object} as from `IMGADM.sourcesGet`:
 *      - @param manifest {Object} The image manifest
 *      - @param source {Object} The source object
 * @param callback {Function} `function (err, stream)`
 */
IMGADM.prototype.sourceGetFileStream = function sourceGetFileStream(
        imageInfo, callback) {
    var self = this;
    assert.object(imageInfo, 'imageInfo');
    assert.object(imageInfo.manifest, 'imageInfo.manifest');
    assert.object(imageInfo.source, 'imageInfo.source');
    assert.func(callback, 'callback');

    self.clientFromSource(imageInfo.source, function (cErr, client) {
        if (cErr) {
            callback(cErr);
            return;
        }
        client.getImageFileStream(imageInfo.manifest.uuid, callback);
    });
};


/**
 * List locally install images.
 *
 * Here `imagesInfo` is an array of objects like this:
 *      {
 *          manifest: {
 *              uuid: UUID,
 *              ...     // may only be uuid if don't have IMGAPI manifest info
 *              ...
 *          },
 *          source: SOURCE-URL,
 *          clones: N   // number of zfs clones from this image
 *      }
 *
 * @param callback {Function} `function (err, imagesInfo)`
 */
IMGADM.prototype.listImages = function listImages(callback) {
    this._loadImages(function (err, imagesInfo) {
        if (err) {
            callback(err);
        } else {
            callback(null, imagesInfo);
        }
    });
};


/**
 * Delete the given image.
 *
 * Dev notes:
 * - Bail if have child clones (We don't support a '-R' recursive delete
 *   option like `zfs destroy -R`. Too dangerous.)
 * - `zfs destroy ZPOOL/UUID` before updating imgadm db, in case we fail
 *   on a race (e.g., someone just cloned it).
 * - Remove imgadm db info.
 *
 * @param options {Object}:
 *      - @param uuid {String}
 *      - @param zpool {String}
 * @param callback {Function} `function (err)`
 */
IMGADM.prototype.deleteImage = function deleteImage(options, callback) {
    assert.object(options, 'options');
    assertUuid(options.uuid, 'options.uuid');
    assert.string(options.zpool, 'options.zpool');
    assert.func(callback, 'callback');
    var self = this;
    var uuid = options.uuid;
    var zpool = options.zpool;

    var getOpts = {uuid: uuid, zpool: zpool, children: true};
    this.getImage(getOpts, function (err, imageInfo) {
        if (err) {
            callback(err);
            return;
        }
        if (!imageInfo) {
            callback(new errors.ImageNotInstalledError(zpool, uuid));
            return;
        }
        if (imageInfo.children.clones.length > 0) {
            callback(new errors.ImageHasDependentClonesError(imageInfo));
            return;
        }

        var cmd = format('/usr/sbin/zfs destroy -r %s/%s', zpool, uuid);
        exec(cmd, function (dErr, stdout, stderr) {
            if (dErr) {
                callback(new errors.InternalError({
                    cause: dErr,
                    message: format('error deleting image "%s": %s',
                                    uuid, dErr)
                }));
                return;
            }
            self._dbDeleteImage(options, callback);
        });
    });
};


/**
 * Import the given image from the given `source`
 *
 * It is up to the caller to ensure this UUID is not already installed.
 *
 * @param options {Object}
 *      - @param manifest {Object} The manifest to import.
 *      - @param zpool {String} The zpool to which to import.
 *      - @param source {Object} The source object from which to import.
 *      - @param quiet {Boolean} Optional. Default false. Set to true
 *        to not have a progress bar for the install.
 *      - @param logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 * @param callback {Function} `function (err)`
 */
IMGADM.prototype.importImage = function importImage(options, callback) {
    assert.object(options, 'options');
    assert.object(options.manifest, 'options.manifest');
    assert.string(options.zpool, 'options.zpool');
    assert.object(options.source, 'options.source');
    assert.optionalBool(options.quiet, 'options.quiet');
    assert.optionalFunc(options.logCb, 'options.logCb');

    // Ensure this image is active (upgrading manifest if required).
    try {
        options.manifest = imgmanifest.upgradeManifest(options.manifest);
    } catch (err) {
        callback(new errors.InvalidManifestError(err));
        return;
    }
    if (options.manifest.state !== 'active') {
        callback(new errors.ImageNotActiveError(options.manifest.uuid));
        return;
    }

    this._installImage(options, callback);
};


/**
 * Install the given image from the given `manifest` and image file path,
 * `file`.
 *
 * It is up to the caller to ensure this UUID is not already installed.
 *
 * @param options {Object}
 *      - @param manifest {Object} The manifest to import.
 *      - @param zpool {String} The zpool to which to import.
 *      - @param file {String} Path to the image file.
 *      - @param quiet {Boolean} Optional. Default false. Set to true
 *        to not have a progress bar for the install.
 *      - @param logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 * @param callback {Function} `function (err)`
 */
IMGADM.prototype.installImage = function installImage(options, callback) {
    assert.object(options, 'options');
    assert.object(options.manifest, 'options.manifest');
    assert.string(options.zpool, 'options.zpool');
    assert.string(options.file, 'options.file');
    assert.optionalBool(options.quiet, 'options.quiet');
    assert.optionalFunc(options.logCb, 'options.logCb');

    this._installImage(options, callback);
};


IMGADM.prototype._lockPathFromUuid = function _lockPathFromUuid(uuid) {
    assertUuid(uuid, 'uuid');
    return '/var/run/img.' + uuid + '.import.lock';
};


/**
 * Install an image from the given manifest and either a local `file` or
 * downloading from a given image `source`.
 */
IMGADM.prototype._installImage = function _installImage(options, callback) {
    var self = this;
    assert.object(options, 'options');
    assert.object(options.manifest, 'options.manifest');
    assert.string(options.zpool, 'options.zpool');
    assert.optionalString(options.file, 'options.file');
    assert.optionalObject(options.source, 'options.source');
    assert.ok((options.file || options.source)
        && !(options.file && options.source),
        'must specify exactly *one* of options.file or options.source');
    assert.optionalBool(options.quiet, 'options.quiet');
    assert.optionalFunc(options.logCb, 'options.logCb');
    var logCb = options.logCb || function () {};
    assert.func(callback, 'callback');
    var uuid = options.manifest.uuid;
    assert.uuid(uuid, 'options.manifest.uuid');
    var log = self.log;
    log.debug({
        zpool: options.zpool,
        manifest: options.manifest,
        sourceUrl: options.source && options.source.url,
        file: options.file
    }, '_installImage');

    // Upgrade manifest if required.
    try {
        var manifest = imgmanifest.upgradeManifest(options.manifest);
    } catch (err) {
        callback(new errors.InvalidManifestError(err));
        return;
    }

    // Context object for the pipeline below (and called helpers).
    var context = {
        imageInfo: {
            manifest: manifest,
            zpool: options.zpool,
            source: options.source
        },
        lockPath: self._lockPathFromUuid(uuid),
        dsName: format('%s/%s', options.zpool, uuid),
        quiet: options.quiet
    };

    vasync.pipeline({arg: context, funcs: [
        /**
         * If this image has an origin, need to ensure it is installed first.
         * If we're streaming from a given IMGAPI `source` then we can try
         * to get the origin as well. If we're just given a file, then nothing
         * we can do.
         */
        function getOrigin(ctx, next) {
            if (!manifest.origin) {
                next();
                return;
            }
            var getOpts = {
                uuid: manifest.origin,
                zpool: options.zpool
            };
            self.getImage(getOpts, function (getErr, oi) {
                ctx.localOriginInfo = oi;
                next(getErr);
            });
        },
        function ensureOrigin(ctx, next) {
            if (!manifest.origin) {
                next();
                return;
            }
            if (ctx.localOriginInfo) {
                next();
            } else if (options.file) {
                next(new errors.OriginNotInstalledError(options.zpool,
                    manifest.origin));
            } else {
                assert.ok(options.source);

                logCb(format('Origin image %s is not installed: '
                    + 'searching source', manifest.origin));
                var getOpts = {
                    uuid: manifest.origin,
                    ensureActive: true,
                    sources: [ctx.imageInfo.source]
                };
                self.sourcesGet(getOpts, function (err, originInfo) {
                    if (err) {
                        next(err);
                        return;
                    } else if (!originInfo) {
                        next(new errors.OriginNotFoundInSourceError(
                            manifest.origin, ctx.imageInfo.source));
                        return;
                    }
                    logCb(format('Importing origin image %s (%s@%s) from "%s"',
                        originInfo.manifest.uuid, originInfo.manifest.name,
                        originInfo.manifest.version, originInfo.source.url));
                    var impOpts = {
                        manifest: originInfo.manifest,
                        zpool: options.zpool,
                        source: originInfo.source,
                        logCb: options.logCb
                    };
                    self.importImage(impOpts, next);
                });
            }
        },

        function acquireLock(ctx, next) {
            var acquireLogTimeout = setTimeout(function () {
                logCb(format('Waiting for image %s import lock', uuid));
            }, 1000);
            log.debug({lockPath: ctx.lockPath}, 'acquire lock');
            lock(ctx.lockPath, function (lockErr, unlockFn_) {
                if (acquireLogTimeout) {
                    clearTimeout(acquireLogTimeout);
                }
                if (lockErr) {
                    next(new errors.InternalError({
                        message: 'error acquiring lock',
                        lockPath: ctx.lockPath,
                        cause: lockErr
                    }));
                    return;
                }
                log.debug({lockPath: ctx.lockPath}, 'acquired lock');
                ctx.unlockFn = unlockFn_;
                next();
            });
        },

        /**
         * While waiting for the lock the image could have been imported.
         */
        function checkIfImportedAfterLock(ctx, next) {
            var getOpts = {
                uuid: uuid,
                zpool: options.zpool
            };
            self.getImage(getOpts, function (getErr, ii) {
                if (getErr) {
                    next(getErr);
                    return;
                } else if (ii) {
                    logCb(format('Image %s (%s@%s) was imported while '
                        + 'waiting on lock', uuid, ii.manifest.name,
                        ii.manifest.version));
                    next(true);  // `true` means early abort
                } else {
                    next();
                }
            });
        },

        function getImageFileInfo(ctx, next) {
            if (options.file) {
                fs.stat(options.file, function (statErr, stats) {
                    if (statErr) {
                        next(statErr);
                        return;
                    }
                    var stream = fs.createReadStream(options.file);
                    stream.pause();
                    ctx.fileInfo = {
                        stream: stream,
                        size: stats.size
                    };
                    next();
                });
            } else {
                assert.ok(options.source);
                self.sourceGetFileStream(ctx.imageInfo, function (err, stream) {
                    if (err) {
                        next(err);
                        return;
                    }
                    if (ctx.imageInfo.source.type !== 'dsapi'
                        && !stream.headers['content-md5'])
                    {
                        next(new errors.DownloadError('image file headers '
                            + 'did not include a "Content-MD5"'));
                        return;
                    }
                    ctx.fileInfo = {
                        stream: stream,
                        size: Number(stream.headers['content-length']),
                        contentMd5: stream.headers['content-md5']
                    };
                    next();
                });
            }
        },

        function _installTheFile(ctx, next) {
            if (manifest.type === 'docker') {
                self._installDockerImage(ctx, next);
            } else {
                self._installZfsImage(ctx, next);
            }
        },

        function saveManifestToDb(ctx, next) {
            // Note that we have a DS to remove if the rest of the import fails.
            ctx.installedDs = true;

            self.dbAddImage(ctx.imageInfo, function (addErr) {
                if (addErr) {
                    log.error({err: addErr, imageInfo: ctx.imageInfo},
                        'error saving image to the database');
                    next(new errors.InternalError(
                        {message: 'error saving image manifest'}));
                } else {
                    next();
                }
            });
        }

    ]}, function finishUp(err) {
        var didTheImport = true;
        if (err === true) {
            // This is the sign that the image was already imported.
            err = null;
            didTheImport = false;
        }

        vasync.pipeline({arg: context, funcs: [
            function rollbackDsIfNecessary(ctx, next) {
                if (err && ctx.installedDs) {
                    var cmd = format('/usr/sbin/zfs destroy -r %s', ctx.dsName);
                    exec(cmd, function (rollbackErr, stdout, stderr) {
                        if (rollbackErr) {
                            log.trace({cmd: cmd, err: rollbackErr,
                                stdout: stdout, stderr: stderr,
                                rollbackDsName: ctx.dsName},
                                'error destroying dataset while rolling back');
                        }
                        next();
                    });
                } else {
                    next();
                }
            },
            function releaseLock(ctx, next) {
                if (!ctx.unlockFn) {
                    next();
                    return;
                }
                log.debug({lockPath: ctx.lockPath}, 'releasing lock');
                ctx.unlockFn(function (unlockErr) {
                    if (unlockErr) {
                        next(new errors.InternalError({
                            message: 'error releasing lock',
                            lockPath: ctx.lockPath,
                            cause: unlockErr
                        }));
                        return;
                    }
                    log.debug({lockPath: ctx.lockPath}, 'released lock');
                    next();
                });
            },
            function noteCompletion(ctx, next) {
                if (didTheImport) {
                    logCb(format('%s image %s (%s@%s) to "%s/%s"',
                        (options.file ? 'Installed' : 'Imported'),
                        uuid,
                        manifest.name,
                        manifest.version,
                        options.zpool,
                        uuid));
                }
                next();
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                log.fatal({err: finishUpErr},
                    'unexpected error finishing up image import');
            }
            callback(err || finishUpErr);
        });
    });
};


/**
 * This handles creating an image in the zpool from a *single* docker
 * layer.
 *
 * - if have origin:
 *      zfs clone zones/$origin@final zones/$uuid
 *   else:
 *      zfs create zones/$uuid
 *      mkdir zones/$uuid/root
 *      crle ...
 * - cd /zones/$uuid/root && tar xf $layerFile
 * - handle .wh.* files
 * - zfs snapshot zones/$uuid@final
 */
IMGADM.prototype._installDockerImage = function _installDockerImage(ctx, cb) {
    var self = this;
    assert.object(ctx, 'ctx');
    assert.object(ctx.fileInfo, 'ctx.fileInfo');
    assert.string(ctx.dsName, 'ctx.dsName');
    assert.string(ctx.imageInfo.zpool, 'ctx.imageInfo.zpool');
    assert.object(ctx.imageInfo.manifest, 'ctx.imageInfo.manifest');
    assert.uuid(ctx.imageInfo.manifest.uuid, 'ctx.imageInfo.manifest.uuid');
    assert.optionalBool(ctx.quiet, 'ctx.quiet');

    var zpool = ctx.imageInfo.zpool;
    var manifest = ctx.imageInfo.manifest;
    var uuid = manifest.uuid;
    var log = self.log;

    var partialDsName = ctx.dsName + '-partial';
    var zoneroot = format('/%s/root', partialDsName, uuid);

    vasync.pipeline({funcs: [
        function cloneOrigin(_, next) {
            if (!manifest.origin) {
                next();
                return;
            }
            var argv = ['/usr/sbin/zfs', 'clone',
                format('%s/%s@final', zpool, manifest.origin), partialDsName];
            execFilePlus({argv: argv, log: log}, next);
        },

        function createNewZoneroot(_, next) {
            if (manifest.origin) {
                next();
                return;
            }
            vasync.pipeline({funcs: [
                function zfsCreate(_2, next2) {
                    var argv = ['/usr/sbin/zfs', 'create', partialDsName];
                    execFilePlus({argv: argv, log: log}, next2);
                },
                // XXX Hope these can go away (discussed with joshw).
                function mkZoneroot(_2, next2) {
                    var argv = ['/usr/bin/mkdir', '-p',
                        zoneroot + '/var/ld/64'];
                    execFilePlus({argv: argv, log: log}, next2);
                },
                function crle(_2, next2) {
                    var argv = ['/usr/bin/crle',
                        '-c', zoneroot + '/var/ld/ld.config',
                        '-l', '/native/lib:/native/usr/lib',
                        '-s', '/native/lib/secure:/native/usr/lib/secure'];
                    execFilePlus({argv: argv, log: log}, next2);
                },
                function crle64(_2, next2) {
                    var argv = ['/usr/bin/crle', '-64',
                        '-c', zoneroot + '/var/ld/64/ld.config',
                        '-l', '/native/lib/64:/native/usr/lib/64',
                        '-s',
                        '/native/lib/secure/64:/native/usr/lib/secure/64'];
                    execFilePlus({argv: argv, log: log}, next2);
                }
            ]}, next);
        },

        function extract(_, next) {
            /**
             * ...stream... | gtar xf -
             *
             * To complete this stage we want to wait for all of:
             * 1. the tar process to 'exit'
             * 2. the pipeline's std handles to 'close'
             *
             * If we get an error we "finish" right away. This `finish` stuff
             * coordinates that.
             *
             * TODO: consider a quick path for 0 length layers. Don't bother
             * transfering the empty content tar, and don't bother with
             * tar process and stream.
             */
            var numToFinish = 2;
            var numFinishes = 0;
            var finished = false;
            function finish(err) {
                numFinishes++;
                if (finished) {
                    /* jsl:pass */
                } else if (err) {
                    finished = true;
                    log.trace({err: err}, 'extract err');
                    next(err);
                } else if (numFinishes >= numToFinish) {
                    finished = true;
                    next();
                }
            }

            if (!ctx.quiet && process.stderr.isTTY) {
                ctx.bar = new ProgressBar({
                    size: ctx.fileInfo.size,
                    filename: uuid
                });
            }

            // Calculate input stream hashes to verify checksum at the end.
            ctx.md5Hash = crypto.createHash('md5');
            ctx.sha1Hash = crypto.createHash('sha1');
            ctx.fileInfo.stream.on('data', function (chunk) {
                if (ctx.bar)
                    ctx.bar.advance(chunk.length);
                ctx.md5Hash.update(chunk);
                ctx.sha1Hash.update(chunk);
            });
            ctx.fileInfo.stream.on('error', finish);

            // tar
            var tar = spawn('/usr/bin/gtar', ['xf', '-'], {cwd: zoneroot});
            tar.stderr.on('data', function (chunk) {
                console.error('tar stderr: %s', chunk.toString());
            });
            tar.stdout.on('data', function (chunk) {
                console.error('tar stdout: %s', chunk.toString());
            });
            tar.on('exit', function (code, signal) {
                if (code !== 0 || signal) {
                    finish(new errors.InternalError({message: format(
                        'tar error extracting docker image: '
                        + 'exit code %s, signal %s', code, signal)}));
                } else {
                    finish();
                }
            });
            tar.on('close', function () {
                finish();
            });

            ctx.fileInfo.stream.pipe(tar.stdin);
            ctx.fileInfo.stream.resume();
        },

        /**
         * Ensure the streamed image data matches expected checksums.
         */
        function checksum(_, next) {
            var err;

            // We have a content-md5 from the headers if the is was streamed
            // from an IMGAPI.
            var md5Expected = ctx.fileInfo.contentMd5;
            if (md5Expected) {
                var md5Actual = ctx.md5Hash.digest('base64');
                if (md5Actual !== md5Expected) {
                    err = new errors.DownloadError(format(
                        'Content-MD5 expected to be %s, but was %s',
                        md5Expected, md5Actual));
                }
            }

            var sha1Expected = manifest.files[0].sha1;
            var sha1Actual = ctx.sha1Hash.digest('hex');
            if (sha1Expected && sha1Actual !== sha1Expected) {
                err = new errors.DownloadError(format(
                    'image file sha1 expected to be %s, but was %s',
                    sha1Expected, sha1Actual));
            }

            if (!err) {
                log.info('checksums match');
            }
            next(err);
        },

        function whiteout(_, next) {
            var find = findit(zoneroot);
            var onceNext = once(next);
            var toRemove = [];
            find.on('file', function (file, stat) {
                var base = path.basename(file);
                if (base.slice(0, 4) === '.wh.') {
                    toRemove.push(path.join(path.dirname(file), base.slice(4)));
                    toRemove.push(file);
                }
            });
            find.on('end', function () {
                log.info({toRemove: toRemove}, 'whiteout files');
                vasync.forEachPipeline({
                    inputs: toRemove,
                    func: rimraf
                }, onceNext);
            });
            find.on('error', onceNext);
        },

        /**
         * As a rule, we want all installed images on SmartOS to have their
         * single base snapshot (from which VMs are cloned) called "@final".
         * `vmadm` presumes this (tho allows for it not to be there for
         * bwcompat). This "@final" snapshot is also necessary for
         * `imgadm create -i` (i.e. incremental images).
         */
        function zfsSnapshot(_, next) {
            var argv = ['/usr/sbin/zfs', 'snapshot', partialDsName + '@final'];
            execFilePlus({argv: argv, log: log}, next);
        },

        /**
         * We created the dataset to a "...-partial" temporary name.
         * Rename it to the final name.
         */
        function renameToFinalDsName(_, next) {
            var argv = ['/usr/sbin/zfs', 'rename', partialDsName, ctx.dsName];
            execFilePlus({argv: argv, log: log}, next);
        }

    ]}, function finishUp(err) {
        if (ctx.bar) {
            ctx.bar.end();
        }
        if (err) {
            // Rollback the currently installed dataset, if necessary.
            // Silently fail here (i.e. only log at debug level) because
            // it is possible we errored out before the -partial dataset
            // was created.
            // TODO: Be specific above about partialDsCreated=true and
            //      key off that.
            var argv = ['/usr/sbin/zfs', 'destroy', '-r',
                partialDsName];
            execFilePlus({argv: argv, log: log},
                    function (rollbackErr, stdout, stderr) {
                if (rollbackErr) {
                    log.debug({argv: argv, err: rollbackErr,
                        rollbackDsName: partialDsName},
                        'error destroying dataset while rolling back');
                }
                cb(err);
            });
        } else {
            cb(err);
        }
    });
};


IMGADM.prototype._installZfsImage = function _installZfsImage(ctx, cb) {
    var self = this;
    assert.object(ctx, 'ctx');
    assert.object(ctx.fileInfo, 'ctx.fileInfo');
    assert.string(ctx.dsName, 'ctx.dsName');
    assert.object(ctx.imageInfo.manifest, 'ctx.imageInfo.manifest');
    assert.uuid(ctx.imageInfo.manifest.uuid, 'ctx.imageInfo.manifest.uuid');
    assert.optionalBool(ctx.quiet, 'ctx.quiet');

    var manifest = ctx.imageInfo.manifest;
    var uuid = manifest.uuid;
    var log = self.log;

    vasync.pipeline({funcs: [
        /**
         * image file stream \                  [A]
         *      | inflator (if necessary) \     [B]
         *      | zfs recv                      [C]
         */
        function recvTheDataset(_, next) {
            // To complete this stage we want to wait for all of:
            // 1. the 'zfs receive' process to 'exit'.
            // 2. the compressor process to 'exit' (if we are compressing)
            // 3. the pipeline's std handles to 'close'
            //
            // If we get an error we "finish" right away. This `finish` stuff
            // coordinates that.
            var numToFinish = 2;  // 1 is added below if compressing.
            var numFinishes = 0;
            var finished = false;
            function finish(err) {
                numFinishes++;
                if (finished) {
                    /* jsl:pass */
                } else if (err) {
                    finished = true;
                    self.log.trace({err: err}, 'recvTheDataset err');
                    next(err);
                } else if (numFinishes >= numToFinish) {
                    finished = true;
                    next();
                }
            }

            if (!ctx.quiet && process.stderr.isTTY) {
                ctx.bar = new ProgressBar({
                    size: ctx.fileInfo.size,
                    filename: uuid
                });
            }

            // [A]
            ctx.md5Hash = crypto.createHash('md5');
            ctx.sha1Hash = crypto.createHash('sha1');
            ctx.fileInfo.stream.on('data', function (chunk) {
                if (ctx.bar)
                    ctx.bar.advance(chunk.length);
                ctx.md5Hash.update(chunk);
                ctx.sha1Hash.update(chunk);
            });
            ctx.fileInfo.stream.on('error', finish);

            // [B]
            var compression = manifest.files[0].compression;
            var uncompressor;
            if (compression === 'bzip2') {
                uncompressor = spawn('/usr/bin/bzip2', ['-cdfq']);
                numToFinish++;
            } else if (compression === 'gzip') {
                uncompressor = spawn('/usr/bin/gzip', ['-cdfq']);
                numToFinish++;
            } else {
                assert.equal(compression, 'none',
                    format('image %s file compression: %s', uuid, compression));
                uncompressor = null;
            }
            if (uncompressor) {
                uncompressor.stderr.on('data', function (chunk) {
                    console.error('Stderr from uncompression: %s',
                        chunk.toString());
                });
                uncompressor.on('exit', function (code) {
                    if (code !== 0) {
                        var msg;
                        if (compression === 'bzip2' && code === 2) {
                            msg = format('%s uncompression error while '
                                + 'importing: exit code %s (corrupt compressed '
                                + 'file): usually indicates a network error '
                                + 'while downloading, try again',
                                compression, code);
                        } else {
                            msg = format('%s uncompression error while '
                                + 'importing: exit code %s', compression, code);
                        }
                        finish(new errors.UncompressionError(msg));
                    } else {
                        finish();
                    }
                });
            }

            // [C]
            ctx.partialDsName = ctx.dsName + '-partial';
            var zfsRecv = spawn('/usr/sbin/zfs',
                ['receive', ctx.partialDsName]);
            zfsRecv.stderr.on('data', function (chunk) {
                console.error('Stderr from zfs receive: %s',
                    chunk.toString());
            });
            zfsRecv.stdout.on('data', function (chunk) {
                console.error('Stdout from zfs receive: %s',
                    chunk.toString());
            });
            zfsRecv.on('exit', function (code) {
                if (code !== 0) {
                    finish(new errors.InternalError({message: format(
                        'zfs receive error while importing: '
                        + 'exit code %s', code)}));
                } else {
                    finish();
                }
            });

            (uncompressor || zfsRecv).on('close', function () {
                self.log.trace('image file receive pipeline closed');
                finish();
            });

            if (uncompressor) {
                uncompressor.stdout.pipe(zfsRecv.stdin);
                ctx.fileInfo.stream.pipe(uncompressor.stdin);
            } else {
                ctx.fileInfo.stream.pipe(zfsRecv.stdin);
            }
            ctx.fileInfo.stream.resume();
        },

        /**
         * Ensure the streamed image data matches expected checksums.
         */
        function checksum(_, next) {
            var err;

            // We have a content-md5 from the headers if the is was streamed
            // from an IMGAPI.
            var md5Expected = ctx.fileInfo.contentMd5;
            if (md5Expected) {
                var md5Actual = ctx.md5Hash.digest('base64');
                if (md5Actual !== md5Expected) {
                    err = new errors.DownloadError(format(
                        'Content-MD5 expected to be %s, but was %s',
                        md5Expected, md5Actual));
                }
            }

            var sha1Expected = manifest.files[0].sha1;
            var sha1Actual = ctx.sha1Hash.digest('hex');
            if (sha1Expected && sha1Actual !== sha1Expected) {
                err = new errors.DownloadError(format(
                    'image file sha1 expected to be %s, but was %s',
                    sha1Expected, sha1Actual));
            }

            next(err);
        },

        /**
         * As a rule, we want all installed images on SmartOS to have their
         * single base snapshot (from which VMs are cloned) called "@final".
         * `vmadm` presumes this (tho allows for it not to be there for
         * bwcompat). This "@final" snapshot is also necessary for
         * `imgadm create -i` (i.e. incremental images).
         *
         * Here we ensure that the snapshot for this image is called "@final",
         * renaming it if necessary.
         */
        function ensureFinalSnapshot(_, next) {
            var properties = ['name', 'children'];
            getZfsDataset(ctx.partialDsName, properties, function (zErr, ds) {
                if (zErr) {
                    next(zErr);
                    return;
                }
                var snapshots = ds.children.snapshots;
                var snapnames = snapshots.map(
                    function (n) { return '@' + n.split(/@/g).slice(-1)[0]; });
                if (snapshots.length !== 1) {
                    next(new errors.UnexpectedNumberOfSnapshotsError(
                        uuid, snapnames));
                } else if (snapnames[0] !== '@final') {
                    var curr = snapshots[0];
                    var finalSnap = curr.split(/@/)[0] + '@final';
                    zfsRenameSnapshot(curr, finalSnap,
                        {recursive: true, log: log}, next);
                } else {
                    next();
                }
            });
        },

        /**
         * We recv'd the dataset to a "...-partial" temporary name. Rename it to
         * the final name.
         */
        function renameToFinalDsName(_, next) {
            var cmd = format('/usr/sbin/zfs rename %s %s',
                ctx.partialDsName, ctx.dsName);
            log.trace({cmd: cmd}, 'rename tmp image');
            exec(cmd, function (err, stdout, stderr) {
                if (err) {
                    log.error({cmd: cmd, err: err, stdout: stdout,
                        stderr: stderr, partialDsName: ctx.partialDsName,
                        dsName: ctx.dsName}, 'error renaming imported image');
                    next(new errors.InternalError(
                        {message: 'error importing'}));
                } else {
                    next();
                }
            });
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function stopProgressBar(_, next) {
                if (ctx.bar) {
                    ctx.bar.end();
                }
                next();
            },
            function rollbackPartialDsIfNecessary(_, next) {
                if (err && ctx.partialDsName) {
                    // Rollback the currently installed dataset, if necessary.
                    // Silently fail here (i.e. only log at trace level) because
                    // it is possible we errored out before the -partial dataset
                    // was created.
                    var cmd = format('/usr/sbin/zfs destroy -r %s',
                        ctx.partialDsName);
                    exec(cmd, function (rollbackErr, stdout, stderr) {
                        if (rollbackErr) {
                            log.trace({cmd: cmd, err: rollbackErr,
                                stdout: stdout,
                                stderr: stderr,
                                rollbackDsName: ctx.partialDsName},
                                'error destroying dataset while rolling back');
                        }
                        next();
                    });
                } else {
                    next();
                }
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                log.fatal({err: finishUpErr},
                    'unexpected error finishing up image import');
            }
            cb(err || finishUpErr);
        });
    });
};



/**
 * Update image database. I.e., attempt to gather info on installed images
 * with no cached manifest info, from current image sources.
 *
 * Dev Note: Currently this just writes progress (updated images) with
 * `console.log`, which isn't very "library-like".
 *
 * @param options {Object}
 *      - uuids {Array} Optional array of uuids to which to limit processing.
 *      - dryRun {Boolean} Default false. Just print changes that would be made
 *        without making them.
 * @param callback {Function} `function (err)`
 */
IMGADM.prototype.updateImages = function updateImages(options, callback) {
    assert.object(options, 'options');
    assert.optionalArrayOfString(options.uuids, 'options.uuids');
    assert.optionalBool(options.dryRun, 'options.dryRun');
    assert.func(callback, 'callback');
    var self = this;
    var updateErrs = [];

    self.listImages(function (listErr, ii) {
        if (listErr) {
            callback(listErr);
            return;
        }

        var imagesInfo = ii;
        if (options.uuids) {
            var iiFromUuid = {};
            ii.forEach(function (i) { iiFromUuid[i.manifest.uuid] = i; });

            imagesInfo = [];
            var missing = [];
            options.uuids.forEach(function (u) {
                if (!iiFromUuid[u]) {
                    missing.push(u);
                } else {
                    imagesInfo.push(iiFromUuid[u]);
                }
            });
            if (missing.length) {
                callback(new errors.UsageError(
                    'no install image with the given UUID(s): '
                    + missing.join(', ')));
                return;
            }
        } else {
            imagesInfo = ii;
        }

        async.forEachSeries(
            imagesInfo,
            updateImage,
            function (err) {
                if (err) {
                    callback(err);
                } else if (updateErrs.length === 1) {
                    callback(updateErrs[0]);
                } else if (updateErrs.length > 1) {
                    callback(new errors.MultiError(updateErrs));
                } else {
                    callback();
                }
            });
    });

    function updateImage(ii, cb) {
        assert.object(ii.manifest, 'ii.manifest');
        assert.string(ii.zpool, 'ii.zpool');

        var uuid = ii.manifest.uuid;
        var sii; // source imageImage
        var snapshots;
        async.series([
            function getSourceInfo(next) {
                var getOpts = {
                    uuid: uuid,
                    ensureActive: false
                };
                self.sourcesGet(getOpts, function (sGetErr, sImageInfo) {
                    if (sGetErr) {
                        next(sGetErr);
                        return;
                    }
                    sii = sImageInfo;
                    if (!sii) {
                        console.log('warning: Could not find image %s in '
                            + 'image sources (skipping)', uuid);
                    }
                    next();
                });
            },
            function getSnapshots(next) {
                if (!sii) {
                    next();
                    return;
                }
                var properties = ['name', 'children'];
                var fsName = format('%s/%s', ii.zpool, uuid);
                getZfsDataset(fsName, properties, function (zErr, ds) {
                    if (zErr) {
                        next(zErr);
                        return;
                    }
                    snapshots = ds.children.snapshots;
                    next();
                });
            },
            function updateManifest(next) {
                if (!sii) {
                    next();
                    return;
                }
                sii.zpool = ii.zpool;
                var msg;
                if (!ii.manifest.name) {
                    // Didn't have any manifest details.
                    msg = format('Added manifest info for image %s from "%s"',
                        uuid, sii.source.url);
                } else {
                    var sm = sii.manifest;
                    var m = ii.manifest;
                    if (JSON.stringify(sm) === JSON.stringify(m)) {
                        // No manifest changes.
                        next();
                        return;
                    }
                    var diffs = common.diffManifestFields(m, sm);
                    // If 'diffs' is empty here, then the early out above just
                    // had order differences.
                    if (diffs.length === 0) {
                        next();
                        return;
                    }
                    msg = format('Updated %d manifest field%s for image '
                        + '%s from "%s": %s', diffs.length,
                        (diffs.length === 1 ? '' : 's'), uuid, sii.source.url,
                        diffs.join(', '));
                }
                if (options.dryRun) {
                    console.log(msg);
                    next();
                    return;
                }
                self.dbAddImage(sii, function (dbAddErr) {
                    if (dbAddErr) {
                        next(dbAddErr);
                        return;
                    }
                    console.log(msg);
                    next();
                });
            },
            function ensureFinalSnapshot(next) {
                if (!sii) {
                    next();
                    return;
                }
                var finalSnapshot = format('%s/%s@final', ii.zpool, uuid);
                if (snapshots.indexOf(finalSnapshot) !== -1) {
                    next();
                    return;
                }

                /**
                 * We don't have a '@final' snapshot for this image.
                 * - If there aren't *any* snapshots, then fail because the
                 *   original has been deleted. For 'vmadm send/receive' to
                 *   ever work the base snapshot for VMs must be the same
                 *   original.
                 * - If the source manifest info doesn't have a
                 *   "files.0.dataset_uuid" then skip (we can't check).
                 * - If there are any, find the one that is the original
                 *   (by machine dataset_uuid to the zfs 'uuid' property).
                 */
                if (snapshots.length === 0) {
                    next(new errors.ImageMissingOriginalSnapshotError(uuid));
                    return;
                }

                var expectedGuid = sii.manifest.files[0].dataset_guid;
                if (!expectedGuid) {
                    console.warn('imgadm: warn: cannot determine original '
                        + 'snapshot for image "%s" (source info has no '
                        + '"dataset_guid")', uuid);
                    next();
                    return;
                }

                var found = null;
                var i = 0;
                async.until(
                    function testDone() {
                        return found || i >= snapshots.length;
                    },
                    function checkOneSnapshot(nextSnapshot) {
                        var snapshot = snapshots[i];
                        i++;
                        var props = ['name', 'guid'];
                        getZfsDataset(snapshot, props, function (zErr, ds) {
                            if (zErr) {
                                nextSnapshot(zErr);
                                return;
                            }
                            if (ds.guid === expectedGuid) {
                                found = snapshot;
                            }
                            nextSnapshot();
                        });

                    },
                    function doneSnapshots(sErr) {
                        if (sErr) {
                            next(sErr);
                        } else if (!found) {
                            next(new errors.ImageMissingOriginalSnapshotError(
                                uuid, expectedGuid));
                        } else {
                            // Rename this snapshot to '@final'.
                            zfsRenameSnapshot(
                                found,
                                finalSnapshot,
                                {recursive: true, log: self.log},
                                function (rErr) {
                                    if (rErr) {
                                        next(rErr);
                                        return;
                                    }
                                    console.log('Renamed image %s original '
                                        + 'snapshot from %s to %s', uuid,
                                        found, finalSnapshot);
                                    next();
                                }
                            );
                        }
                    }
                );
            }
        ], cb);
    }
};


/**
 * Create an image from the given VM and manifest data. There are two basic
 * calling modes here:
 * 1. A `options.prepareScript` is provided to be used to prepare the VM
 *    before image creation. The running of the prepare script is gated by
 *    a snapshot and rollback so that the end result is a VM that is unchanged.
 *    This is desireable because (a) it is easier (fewer steps to follow
 *    for imaging) and (b) the typical preparation script is destructive, so
 *    gating with snapshotting makes the original VM re-usable. Note that
 *    the snapshotting and preparation involve reboots of the VM (typically
 *    two reboots).
 *    Dev Note: This mode with prepareScript is called "autoprep" in vars
 *    below.
 * 2. The VM is already prepared (via the typical prepare-image scripts,
 *    see <https://download.joyent.com/pub/prepare-image/>) and shutdown.
 *    For this "mode" do NOT pass in `options.prepareScript`.
 *
 * @param options {Object}
 *      - @param vmUuid {String} UUID of the VM from which to create the image.
 *      - @param manifest {Object} Data to include in the created manifest.
 *      - @param logCb {Function} Optional. A function that is called
 *        with progress messages. Called as `logCb(<string>)`. E.g. passing
 *        console.log is legal.
 *      - @param compression {String} Optional compression type for the image
 *        file. Default is 'none'.
 *      - @param savePrefix {String} Optional. The file path prefix to which
 *        to save the manifest and image files.
 *      - @param incremental {Boolean} Optional. Default false. Create an
 *        incremental image.
 *      - @param prepareScript {String} Optional. A script to run to prepare
 *        the VM for image. See note above.
 *      - @param prepareTimeout {Number} Optional. Default is 300 (5 minutes).
 *        The number of seconds before timing out any prepare *stage*. The
 *        preparation stages are (starting from the VM being shutdown):
 *        prepare-image running, prepare-image complete, VM stopped.
 * @param callback {Function} `function (err, imageInfo)` where imageInfo
 *      has `manifest` (the manifest object), `manifestPath` (the saved
 *      manifest path) and `filePath` (the saved image file path) keys.
 */
IMGADM.prototype.createImage = function createImage(options, callback) {
    var self = this;
    assert.object(options, 'options');
    assert.string(options.vmUuid, 'options.vmUuid');
    assert.object(options.manifest, 'options.manifest');
    assert.optionalFunc(options.logCb, 'options.logCb');
    assert.optionalString(options.compression, 'options.compression');
    assert.optionalBool(options.incremental, 'options.incremental');
    assert.optionalString(options.prepareScript, 'options.prepareScript');
    assert.optionalNumber(options.prepareTimeout, 'options.prepareTimeout');
    assert.optionalNumber(options.maxOriginDepth, 'options.maxOriginDepth');
    var log = self.log;
    var vmUuid = options.vmUuid;
    var incremental = options.incremental || false;
    var logCb = options.logCb || function () {};
    var prepareScript = options.prepareScript;
    var prepareTimeout = options.prepareTimeout || 300;  // in seconds
    var maxOriginDepth = options.maxOriginDepth;

    var vmInfo;
    var sysinfo;
    var vmZfsFilesystemName;
    var vmZfsSnapnames;
    var originInfo;
    var originFinalSnap;
    var imageInfo = {};
    var finalSnapshot;
    var toCleanup = {};
    async.waterfall([
        function validateVm(next) {
            common.vmGet(vmUuid, {log: log}, function (err, vm) {
                // Currently `vmGet` doesn't distinguish bwtn some unexpected
                // error and no such VM.
                if (err) {
                    next(new errors.VmNotFoundError(vmUuid));
                    return;
                }
                if (!prepareScript && vm.state !== 'stopped') {
                    next(new errors.VmNotStoppedError(vmUuid));
                    return;
                }
                vmInfo = vm;
                next();
            });
        },
        function getVmInfo(next) {
            var opts;
            if (vmInfo.brand === 'kvm') {
                if (vmInfo.disks) {
                    for (var i = 0; i < vmInfo.disks.length; i++) {
                        if (vmInfo.disks[i].image_uuid) {
                            var disk = vmInfo.disks[i];
                            opts = {uuid: disk.image_uuid, zpool: disk.zpool};
                            vmZfsFilesystemName = disk.zfs_filesystem;
                            break;
                        }
                    }
                }
            } else {
                opts = {uuid: vmInfo.image_uuid, zpool: vmInfo.zpool};
                vmZfsFilesystemName = vmInfo.zfs_filesystem;
            }
            if (!opts) {
                // Couldn't find an origin image.
                log.debug('no origin image found');
                next();
                return;
            }
            self.getImage(opts, function (getErr, ii) {
                if (getErr) {
                    next(getErr);
                    return;
                }
                log.debug({imageInfo: ii}, 'origin image');
                originInfo = ii;
                next();
            });
        },
        function validateMaxOriginDepth(next) {
            // If there is no origin, no depth was passed or origin doesn't
            // have an origin itself
            if (!originInfo || !maxOriginDepth || !originInfo.manifest.origin) {
                next();
                return;
            }
            var currentDepth = 1;
            // One origin is already one level deep
            var currentOrigin = originInfo;
            var foundFirstOrigin = false;

            // Recursively call getImage until we find the source origin
            async.whilst(
                function () {
                    return currentDepth <= maxOriginDepth && !foundFirstOrigin;
                },
                function (cb) {
                    if (!currentOrigin.manifest.origin) {
                        foundFirstOrigin = true;
                        cb();
                        return;
                    }
                    var getOpts = {
                        uuid: currentOrigin.manifest.origin,
                        zpool: currentOrigin.zpool
                    };
                    self.getImage(getOpts, function (getErr, origImg) {
                        if (getErr) {
                            cb(getErr);
                            return;
                        }
                        currentDepth++;
                        currentOrigin = origImg;
                        cb();
                    });
                },
                function (err) {
                    if (err) {
                        next(err);
                        return;
                    }
                    // If we exited the loop because we hit maxOriginDepth
                    if (currentDepth > maxOriginDepth) {
                        next(new errors.MaxOriginDepthError(maxOriginDepth));
                        return;
                    } else {
                        next();
                        return;
                    }
                }
            );
        },
        function getSystemInfo(next) {
            if (vmInfo.brand === 'kvm') {
                next();
                return;
            }
            // We need `sysinfo` for smartos images. See below.
            getSysinfo(log, function (err, sysinfo_) {
                sysinfo = sysinfo_;
                next(err);
            });
        },
        function gatherManifest(next) {
            var m = {
                v: common.MANIFEST_V,
                uuid: genUuid()
            };
            m = imageInfo.manifest = objCopy(options.manifest, m);
            if (originInfo) {
                var originManifest = originInfo.manifest;
                logCb(format('Inheriting from origin image %s (%s %s)',
                    originManifest.uuid, originManifest.name,
                    originManifest.version));
                // IMGAPI-227 TODO: document these and note them in the
                // imgapi docs. These should come from imgmanifest constant.
                var INHERITED_FIELDS = ['type', 'os', 'requirements',
                    'users', 'billing_tags', 'traits', 'generate_passwords',
                    'inherited_directories', 'nic_driver', 'disk_driver',
                    'cpu_type', 'image_size'];
                // TODO Should this *merge* requirements?
                INHERITED_FIELDS.forEach(function (field) {
                    if (!m.hasOwnProperty(field)
                        && originManifest.hasOwnProperty(field))
                    {
                        var val = originManifest[field];
                        // Drop empty arrays, e.g. `billing_tags`, just to
                        // be leaner/cleaner.
                        if (!Array.isArray(val) || val.length > 0) {
                            m[field] = val;
                        }
                    }
                });
            }
            if (vmInfo.brand !== 'kvm' /* i.e. this is a smartos image */
                && !(options.manifest.requirements
                    && options.manifest.requirements.min_platform))
            {
                // Unless an explicit min_platform is provided (possibly empty)
                // the min_platform for a SmartOS image must be the current
                // platform, b/c that's the SmartOS binary compat story.
                if (!m.requirements)
                    m.requirements = {};
                m.requirements.min_platform = {};
                m.requirements.min_platform[sysinfo['SDC Version']]
                    = sysinfo['Live Image'];
                log.debug({min_platform: m.requirements.min_platform},
                    'set smartos image min_platform to current');
            }
            if (incremental) {
                if (!originInfo) {
                    next(new errors.VmHasNoOriginError(vmUuid));
                    return;
                } else {
                    m.origin = originInfo.manifest.uuid;
                }
            }
            logCb(format('Manifest:\n%s',
                _indent(JSON.stringify(m, null, 2))));
            next();
        },
        function validateManifest(next) {
            var errs = imgmanifest.validateMinimalManifest(imageInfo.manifest);
            if (errs) {
                next(new errors.ManifestValidationError(errs));
            } else {
                next();
            }
        },
        function ensureOriginFinalSnapshot(next) {
            if (!incremental) {
                next();
                return;
            }
            originFinalSnap = format('%s/%s@final', originInfo.zpool,
                imageInfo.manifest.origin);
            getZfsDataset(originFinalSnap, function (err, ds) {
                if (err) {
                    next(err);
                } else if (!ds) {
                    next(new errors.OriginHasNoFinalSnapshotError(
                        imageInfo.manifest.origin));
                } else {
                    next();
                }
            });
        },

        function getVmZfsDataset(next) {
            // Get snapshot/children dataset details on the ZFS filesystem with
            // which we are going to be mucking.
            var properties = ['name', 'children'];
            getZfsDataset(vmZfsFilesystemName, properties, function (zErr, ds) {
                if (zErr) {
                    next(zErr);
                    return;
                }
                var snapshots = ds.children.snapshots;
                vmZfsSnapnames = snapshots.map(
                    function (n) { return '@' + n.split(/@/g).slice(-1)[0]; });
                next();
            });
        },

        // If `prepareScript` was given, here is where we need to:
        // - snapshot the VM
        // - prepare the VM
        function autoprepStopVmIfNecessary(next) {
            if (!prepareScript) {
                next();
            } else if (vmInfo.state !== 'stopped') {
                logCb(format('Stopping VM %s to snapshot it', vmUuid));
                toCleanup.autoprepStartVm = vmUuid; // Re-start it when done.
                common.vmStop(vmUuid, {log: log}, next);
            } else {
                next();
            }
        },
        function autoprepSnapshotDatasets(next) {
            if (!prepareScript) {
                next();
                return;
            }

            var toSnapshot = [vmInfo.zfs_filesystem];
            if (vmInfo.brand === 'kvm' && vmInfo.disks) {
                for (var i = 0; i < vmInfo.disks.length; i++) {
                    toSnapshot.push(vmInfo.disks[i].zfs_filesystem);
                }
            }

            var snapname = '@imgadm-create-pre-prepare';
            logCb(format('Snapshotting VM "%s" to %s', vmUuid, snapname));
            toCleanup.autoprepSnapshots = [];
            async.eachSeries(
                toSnapshot,
                function snapshotOne(ds, nextSnapshot) {
                    var snap = ds + snapname;
                    zfs.snapshot(snap, function (zfsErr) {
                        if (zfsErr) {
                            nextSnapshot(new errors.InternalError({
                                message: 'error creating snapshot',
                                snap: snap,
                                cause: zfsErr
                            }));
                            return;
                        }
                        toCleanup.autoprepSnapshots.push(snap);
                        nextSnapshot();
                    });
                },
                next);
        },
        function autoprepSetOperatorScript(next) {
            if (!prepareScript) {
                next();
                return;
            }
            var update = {
                set_internal_metadata: {
                    'operator-script': prepareScript
                }
            };
            log.debug('set operator-script');
            common.vmUpdate(vmUuid, update, {log: log}, next);
        },
        /**
         * "Prepare" the VM by booting it, which should run the
         * operator-script to prepare and shutdown. We track progress via
         * the 'prepare-image:state' and 'prepare-image:error' keys on
         * customer_metadata. See the "PREPARE IMAGE SCRIPT" section in the
         * man page for the contract.
         */
        function autoprepClearMdata(next) {
            if (!prepareScript) {
                next();
                return;
            }
            var update = {
                remove_customer_metadata: [
                    'prepare-image:state',
                    'prepare-image:error'
                ]
            };
            log.debug('create prepare-image:* customer_metadata');
            common.vmUpdate(vmUuid, update, {log: log}, next);
        },
        function autoprepBoot(next) {
            if (!prepareScript) {
                next();
                return;
            }
            logCb(format('Preparing VM %s (starting it)', vmUuid));
            common.vmStart(vmUuid, {log: log}, next);
        },
        function autoprepWaitForRunning(next) {
            if (!prepareScript) {
                next();
                return;
            }
            var opts = {
                log: log,
                key: 'prepare-image:state',
                // Don't explicitly check for value=running here because it is
                // fine if it blows by to 'success' between our polling.
                timeout: prepareTimeout * 1000,
                interval: 2000
            };
            log.debug('wait for up to %ds for prepare-image:state signal '
                + 'from operator-script', prepareTimeout);
            common.vmWaitForCustomerMetadatum(vmUuid, opts, function (err, vm) {
                if (err) {
                    if (err.code === 'Timeout') {
                        /**
                         * This could mean any of:
                         * - the VM has old guest tools that either don't run
                         *   an 'sdc:operator-script' or don't have a working
                         *   'mdata-put'
                         * - the VM boot + time to get to prepare-image script
                         *   setting 'prepare-image:state' mdata takes >5
                         *   minutes
                         * - the prepare-image script has a bug in that it does
                         *   not set the 'prepare-image:state' mdata key to
                         *   'running'
                         * - the prepare-image script crashed early
                         */
                        logCb('Timeout waiting for prepare-image script to '
                            + 'signal it started');
                        log.debug('timeout waiting for operator-script to '
                            + 'set prepare-image:state');
                        next(new errors.PrepareImageDidNotRunError(vmUuid));
                    } else {
                        log.debug(err, 'unexpected error waiting for '
                            + 'operator-script to set prepare-image:state');
                        next(err);
                    }
                    return;
                }
                logCb('Prepare script is running');
                vmInfo = vm;
                next();
            });
        },
        function autoprepWaitForComplete(next) {
            if (!prepareScript) {
                next();
                return;
            }
            var opts = {
                log: log,
                key: 'prepare-image:state',
                values: ['success', 'error'],
                timeout: prepareTimeout * 1000
            };
            log.debug('wait for up to %ds for prepare-image:state of "error" '
                + 'or "success"', prepareTimeout);
            common.vmWaitForCustomerMetadatum(vmUuid, opts, function (err, vm) {
                if (err) {
                    next(new errors.PrepareImageError(err, vmUuid,
                        'prepare-image script did not complete'));
                    return;
                }
                vmInfo = vm;
                var cm = vm.customer_metadata;
                log.debug({
                    'prepare-image:state': cm['prepare-image:state'],
                    'prepare-image:error': cm['prepare-image:error'],
                    'prepare-image:progress': cm['prepare-image:progress']
                }, 'prepare-image:state is set');
                if (cm['prepare-image:state'] === 'error') {
                    next(new errors.PrepareImageError(vmUuid,
                        cm['prepare-image:error'] || ''));
                } else {
                    logCb('Prepare script succeeded');
                    next();
                }
            });
        },
        function autoprepWaitForVmStopped(next) {
            if (!prepareScript) {
                next();
                return;
            }
            var opts = {
                state: 'stopped',
                timeout: prepareTimeout * 1000,
                log: log
            };
            log.debug('wait for up to %ds for VM to stop', prepareTimeout);
            common.vmWaitForState(vmUuid, opts, function (err, vm) {
                if (err) {
                    next(new errors.PrepareImageError(err, vmUuid,
                        'VM did not shutdown'));
                    return;
                }
                var cm = vm.customer_metadata;
                log.debug({
                    'prepare-image:state': cm['prepare-image:state'],
                    'prepare-image:error': cm['prepare-image:error'],
                    'prepare-image:progress': cm['prepare-image:progress']
                }, 'prepare-image stopped VM');
                logCb('Prepare script stopped VM ' + vmUuid);
                next();
            });
        },

        function renameFinalSnapshotOutOfTheWay(next) {
            // We use a snapshot named '@final'. If there is an existing one,
            // rename it to '@final-$timestamp'.
            if (vmZfsSnapnames.indexOf('@final') == -1) {
                next();
                return;
            }
            var curr = vmZfsFilesystemName + '@final';
            var outofway = curr + '-' + Date.now();
            logCb(format('Moving existing @final snapshot out of the '
                + 'way to "%s"', outofway));
            zfsRenameSnapshot(curr, outofway,
                {recursive: true, log: log}, next);
        },
        function snapshotVm(next) {
            // We want '@final' to be the snapshot in the created image -- see
            // the notes in _installImage.
            finalSnapshot = format('%s@final', vmZfsFilesystemName);
            logCb(format('Snapshotting to "%s"', finalSnapshot));
            zfs.snapshot(finalSnapshot, function (zfsErr) {
                if (zfsErr) {
                    next(new errors.InternalError({
                        message: 'error creating final snapshot',
                        finalSnapshot: finalSnapshot,
                        cause: zfsErr
                    }));
                    return;
                }
                toCleanup.finalSnapshot = finalSnapshot;
                next();
            });
        },
        function sendImageFile(next) {
            // 'zfs send' the image snapshot to a local file. We *could*
            // stream directly to an optional IMGAPI target, but that makes
            // it more difficult to do (a) sha1 pre-caculation for upload
            // checking and (b) eventual re-upload support.

            // To complete this stage we want to wait for all of:
            // 1. the 'zfs send' process to 'exit'.
            // 2. the compressor process to 'exit' (if we are compressing)
            // 3. the pipeline's std handles to 'close'
            //
            // If we get an error we "finish" right away. This `finish` stuff
            // coordinates that.
            var numToFinish = 2;  // 1 is added below if compressing.
            var numFinishes = 0;
            var finished = false;
            function finish(err) {
                numFinishes++;
                if (finished) {
                    /* jsl:pass */
                } else if (err) {
                    finished = true;
                    log.trace({err: err}, 'sendImageFile err');
                    next(err);
                } else if (numFinishes >= numToFinish) {
                    finished = true;
                    next();
                }
            }

            imageInfo.filePath = options.savePrefix;
            if (imageInfo.manifest.type === 'zvol') {
                imageInfo.filePath += '.zvol';
            } else {
                imageInfo.filePath += '.zfs';
            }
            logCb(format('Sending image file to "%s"', imageInfo.filePath));

            // Compression
            var compression = options.compression || 'none';
            var compressor;
            if (compression === 'none') {
                /* pass through */
                compressor = null;
            } else if (compression === 'bzip2') {
                compressor = spawn('/usr/bin/bzip2', ['-cfq']);
                imageInfo.filePath += '.bz2';
                numToFinish++;
            } else if (compression === 'gzip') {
                compressor = spawn('/usr/bin/gzip', ['-cfq']);
                imageInfo.filePath += '.gz';
                numToFinish++;
            } else {
                finish(new errors.UsageError(format(
                    'unknown compression "%s"', compression)));
                return;
            }
            if (compressor) {
                toCleanup.compressor = compressor;
                var compStderrChunks = [];
                compressor.stderr.on('data', function (chunk) {
                    compStderrChunks.push(chunk);
                });
                compressor.on('exit', function (code) {
                    delete toCleanup.compressor;
                    if (code !== 0) {
                        toCleanup.filePath = imageInfo.filePath;
                        var msg = format(
                            'error compressing zfs stream: exit code %s\n'
                            + '    compression: %s\n'
                            + '    stderr:\n%s', code, compression,
                            _indent(compStderrChunks.join(''), '        '));
                        log.debug(msg);
                        finish(new errors.InternalError({message: msg}));
                    } else {
                        log.trace({compression: compression},
                            'compressor exited successfully');
                        finish();
                    }
                });
            }

            // Don't want '-p' or '-r' options to 'zfs send'.
            var zfsArgs = ['send'];
            if (incremental) {
                zfsArgs.push('-i');
                zfsArgs.push(originFinalSnap);
            }
            zfsArgs.push(finalSnapshot);
            self.log.debug({cmd: ['/usr/sbin/zfs'].concat(zfsArgs)},
                'spawn zfs send');
            var zfsSend = spawn('/usr/sbin/zfs', zfsArgs);
            var zfsStderrChunks = [];
            zfsSend.stderr.on('data', function (chunk) {
                zfsStderrChunks.push(chunk);
            });
            toCleanup.zfsSend = zfsSend;
            zfsSend.on('exit', function (code) {
                delete toCleanup.zfsSend;
                if (code !== 0) {
                    toCleanup.filePath = imageInfo.filePath;
                    var msg = format('zfs send error: exit code %s\n'
                        + '    cmd: /usr/sbin/zfs %s\n'
                        + '    stderr:\n%s', code,
                        zfsArgs.join(' '),
                        _indent(zfsStderrChunks.join(''), '        '));
                    self.log.debug(msg);
                    finish(new errors.InternalError({message: msg}));
                } else {
                    self.log.trace({zfsArgs: zfsArgs},
                        'zfs send exited successfully');
                    finish();
                }
            });

            var size = 0;
            var sha1Hash = crypto.createHash('sha1');
            (compressor || zfsSend).stdout.on('data', function (chunk) {
                size += chunk.length;
                try {
                    sha1Hash.update(chunk);
                } catch (e) {
                    self.log.debug({err: e}, 'hash update error');
                    finish(new errors.InternalError({
                        cause: e,
                        message: format(
                            'hash error calculating image file sha1: %s', e)
                    }));
                }
            });
            (compressor || zfsSend).on('close', function () {
                imageInfo.manifest.files = [ {
                    size: size,
                    compression: compression,
                    sha1: sha1Hash.digest('hex')
                } ];

                // This is our successful exit point from this step.
                self.log.trace('image file send pipeline closed successfully');
                finish();
            });

            var out = fs.createWriteStream(imageInfo.filePath);
            if (compressor) {
                // zfs send -> bzip2/gzip -> filePath
                zfsSend.stdout.pipe(compressor.stdin);
                compressor.stdout.pipe(out);
            } else {
                // zfs send -> filePath
                zfsSend.stdout.pipe(out);
            }
        },
        function saveManifest(next) {
            var manifestPath = imageInfo.manifestPath
                = options.savePrefix + '.imgmanifest';
            logCb(format('Saving manifest to "%s"', manifestPath));
            var manifestStr = JSON.stringify(imageInfo.manifest, null, 2);
            fs.writeFile(manifestPath, manifestStr, 'utf8', function (wErr) {
                if (wErr) {
                    next(new errors.FileSystemError(wErr, format(
                        'error saving manifest to "%s": %s', manifestPath,
                        wErr)));
                    return;
                }
                next();
            });
        }
    ], function (err) {
        async.series([
            function cleanupZfsSend(next) {
                if (!toCleanup.zfsSend) {
                    next();
                    return;
                }
                self.log.debug('killing zfsSend process');
                toCleanup.zfsSend.on('exit', function () {
                    self.log.debug('zfsSend process exited');
                    next();
                });
                toCleanup.zfsSend.kill('SIGKILL');
            },
            function cleanupCompressor(next) {
                if (!toCleanup.compressor) {
                    next();
                    return;
                }
                self.log.debug('killing compressor process');
                toCleanup.compressor.on('exit', function () {
                    self.log.debug('compressor process exited');
                    next();
                });
                toCleanup.compressor.kill('SIGKILL');
            },
            function cleanupImageFile(next) {
                if (!toCleanup.filePath) {
                    next();
                    return;
                }
                self.log.debug('remove incomplete image file "%s"',
                    toCleanup.filePath);
                rimraf(toCleanup.filePath, next);
            },
            function cleanupFinalSnapshot(next) {
                if (!toCleanup.finalSnapshot) {
                    next();
                    return;
                }
                zfsDestroy(toCleanup.finalSnapshot, self.log, next);
            },
            /**
             * Restoring the VM dataset(s) to their previous state in 3 parts:
             * 1. ensure the VM is stopped (it is surprising if it isn't)
             * 2. rollback all the zfs filesystems
             * 3. destroy the snaps
             */
            function cleanupAutoprepSnapshots1(next) {
                if (!toCleanup.autoprepSnapshots) {
                    next();
                    return;
                }
                logCb(format('Rollback VM %s to pre-prepare snapshot (cleanup)',
                    vmUuid));
                var opts = {log: self.log};
                common.vmHaltIfNotStopped(vmUuid, opts, next);
            },
            function cleanupAutoprepSnapshots2(next) {
                if (!toCleanup.autoprepSnapshots) {
                    next();
                    return;
                }
                async.eachSeries(
                    toCleanup.autoprepSnapshots,
                    function rollbackOne(snap, nextSnapshot) {
                        self.log.debug('zfs rollback', snap);
                        zfs.rollback(snap, nextSnapshot);
                    },
                    next);
            },
            function cleanupAutoprepSnapshots3(next) {
                if (!toCleanup.autoprepSnapshots) {
                    next();
                    return;
                }
                async.eachSeries(
                    toCleanup.autoprepSnapshots,
                    function destroyOne(snap, nextSnapshot) {
                        zfsDestroy(snap, self.log, nextSnapshot);
                    },
                    next);
            },
            function cleanupAutoprepStartVm(next) {
                if (!toCleanup.autoprepStartVm) {
                    next();
                    return;
                }
                logCb(format('Restarting VM %s (cleanup)',
                    toCleanup.autoprepStartVm));
                common.vmStart(toCleanup.autoprepStartVm,
                    {log: self.log}, next);
            }
        ], function (cleanErr) {
            var e = err || cleanErr;
            if (err && cleanErr) {
                e = new errors.MultiError([err, cleanErr]);
            }
            callback(e, imageInfo);
        });
    });
};


/**
 * Publish the given image to the given IMGAPI.
 *
 * @param options {Object}
 *      - @param manifest {Object} The manifest to import.
 *      - @param file {String} The image file path to import.
 *      - @param url {String} The IMGAPI URL to which to publish.
 *      - @param quiet {Boolean} Optional. Default false. Set to true
 *        to not have a progress bar for the file upload.
 * @param callback {Function} `function (err, image)`
 */
IMGADM.prototype.publishImage = function publishImage(opts, callback) {
    assert.object(opts, 'options');
    assert.object(opts.manifest, 'options.manifest');
    var manifest = opts.manifest;
    assert.string(opts.file, 'options.file');
    assert.string(opts.url, 'options.url');
    assert.optionalBool(opts.quiet, 'options.quiet');
    // At least currently we require the manifest to have the file info
    // (as it does if created by 'imgadm create').
    assert.arrayOfObject(manifest.files, 'options.manifest.files');
    var manifestFile = manifest.files[0];
    assert.object(manifestFile, 'options.manifest.files[0]');
    assert.string(manifestFile.compression,
        'options.manifestFile.files[0].compression');
    var self = this;

    var client = imgapi.createClient({
        agent: false,
        url: opts.url,
        log: self.log.child({component: 'api', url: opts.url}, true),
        rejectUnauthorized: (process.env.IMGADM_INSECURE !== '1'),
        userAgent: self.userAgent
    });
    var uuid = manifest.uuid;
    var rollbackImage;
    var activatedImage;

    async.series([
        function importIt(next) {
            client.adminImportImage(manifest, {}, function (err, image, res) {
                self.log.trace({err: err, image: image, res: res},
                    'AdminImportImage');
                if (err) {
                    next(self._errorFromClientError(opts.url, err));
                    return;
                }
                console.log('Imported image %s (%s, %s, state=%s)',
                    image.uuid, image.name, image.version, image.state);
                rollbackImage = image;
                next();
            });
        },
        function addFile(next) {
            var stream = fs.createReadStream(opts.file);
            imgapi.pauseStream(stream);

            var bar;
            if (!opts.quiet && process.stderr.isTTY) {
                bar = new ProgressBar({
                    size: manifestFile.size,
                    filename: uuid
                });
            }
            stream.on('data', function (chunk) {
                if (bar)
                    bar.advance(chunk.length);
            });
            stream.on('end', function () {
                if (bar)
                    bar.end();
            });

            var fopts = {
                uuid: uuid,
                file: stream,
                size: manifestFile.size,
                compression: manifestFile.compression,
                sha1: manifestFile.sha1
            };
            client.addImageFile(fopts, function (err, image, res) {
                self.log.trace({err: err, image: image, res: res},
                    'AddImageFile');
                if (err) {
                    if (bar)
                        bar.end();
                    next(self._errorFromClientError(opts.url, err));
                    return;
                }

                console.log('Added file "%s" (compression "%s") to image %s',
                    opts.file, manifestFile.compression, uuid);

                // Verify uploaded size and sha1.
                var expectedSha1 = manifestFile.sha1;
                if (expectedSha1 !== image.files[0].sha1) {
                    next(new errors.UploadError(format(
                        'sha1 expected to be %s, but was %s',
                        expectedSha1, image.files[0].sha1)));
                    return;
                }
                var expectedSize = manifestFile.size;
                if (expectedSize !== image.files[0].size) {
                    next(new errors.UploadError(format(
                        'size expected to be %s, but was %s',
                        expectedSize, image.files[0].size)));
                    return;
                }

                next();
            });
        },
        function activateIt(next) {
            client.activateImage(uuid, function (err, image, res) {
                self.log.trace({err: err, image: image, res: res},
                    'ActivateImage');
                if (err) {
                    next(self._errorFromClientError(opts.url, err));
                    return;
                }
                activatedImage = image;
                console.log('Activated image %s', uuid);
                next();
            });
        }
    ], function (err) {
        if (err) {
            if (rollbackImage) {
                self.log.debug({err: err, rollbackImage: rollbackImage},
                    'rollback partially imported image');
                var delUuid = rollbackImage.uuid;
                client.deleteImage(uuid, function (delErr, res) {
                    self.log.trace({err: delErr, res: res}, 'DeleteImage');
                    if (delErr) {
                        self.log.debug({err: delErr}, 'error rolling back');
                        console.log('Warning: Could not delete partially '
                            + 'published image %s: %s', delUuid, delErr);
                    }
                    callback(err);
                });
            } else {
                callback(err);
            }
        } else {
            callback(null, activatedImage);
        }
    });
};


// ---- exports

/**
 * Create an IMGADM tool.
 *
 * @params options {Object}
 *      - log {Bunyan Logger} Required.
 * @params callback {Function} `function (err)`
 */
function createTool(options, callback) {
    var tool = new IMGADM(options);
    tool.init(function (err) {
        if (err) {
            callback(err);
            return;
        }
        tool.log.trace({config: tool.config}, 'tool initialized');
        callback(null, tool);
    });
}

module.exports = {
    createTool: createTool
};
