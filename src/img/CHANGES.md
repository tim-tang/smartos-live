# imgadm changelog

## 2.7.0

- Add preliminary support for importing images of `type: 'docker'`,
  where the image file content is the native Docker image format
  (a tarball of changed files with ".wh*" AUFS whiteout files).
  Note that this still implies using an IMGAPI source for pulling
  images -- pulling from the Docker Index/Registry API is not
  supported in this change.

- `imgadm list [<filters>]` support for filtering with 'field=value'
  arguments. E.g., `imgadm list type=docker`.

- Add the `imgadm ancestry <uuid>` command to list the full ancestry
  (i.e. walk the `origin` chanin) of the given installed image.


## 2.6.13

- [OS-2989] Fix 'imgadm import UUID' *when importing from a DSAPI source*
  (e.g. https://datasets.joyent.com/datasets). This has been broken since
  v2.2.0. Note that import from an IMGAPI source (the default and more
  common) is fine.


## 2.6.12

- [OS-2981, joyent/smartos-live#322] Fix 'imgadm avail' crash with a DSAPI
  image source.


## 2.6.11

- [OS-2961] Fix a breakage in 'imgadm import' introduced in version 2.6.10.


## 2.6.10

Note: This was a bad version. Use 2.6.11 or later.

- [IMGAPI-395] Fix race in IMGAPI client that could result in
  spurious 'imgadm import' errors.
- [OS-2925] 'imgadm update' should include disabled images


## 2.6.9

- [OS-2903] Error out with 'OriginNotFoundInSource' instead of crashing if
  an attempt to import an image cannot proceed if the source IMGAPI does
  not have the image's origin image. (This is a bug in the source IMGAPI,
  but `imgadm` still should not crash.)


## 2.6.8

- [IMGAPI-373] `imgadm avail` now returns all images by making use of limit and
  marker implicitly instead of forcing the client to pass these values as
  command line options.


## 2.6.7

- [OS-2878] Fix 'imgadm import' broken in previous version.


## 2.6.6

Note: This was a bad version in which "imgadm import" was broken.
Use version 2.6.7 or later.

- Debug logging will include a "req_id", optionally taken from a `REQ_ID`
  environment variable.

- [OS-2203] 'imgadm import' and 'imgadm avail' will coordinate concurrent
  attempts to import the same image, instead of having all but one of them
  fail.


## 2.6.5

- [OS-2867] Add optional `config.userAgentExtra` for a string to append to
  the User-Agent in IMGAPI client usage.


## 2.6.4

- [OS-2484] Support for incremental of incremental image creation. Added
  --max-origin-depth to `imgadm create` to allow setting a limit in the number
  of child incremental images for an image.


## 2.6.3

- [OS-2657] Fix an issue where an error message with a printf formatting char
  could crash on error creation: loosing error details.


## 2.6.2

- [IMGAPI-312] `imgadm create` will set "requirements.min_platform" to the
  current platform for *SmartOS* images, to ensure proper binary compatibility
  -- in case the image includes binaries built on this platform.


## 2.6.1

- Include User-Agent header in requests to IMGAPI and DSAPI sources,
  e.g. "imgadm/2.6.1 (node/0.8.26; OpenSSL/1.0.1d)".

- [OS-2651] Fix 'imgadm create' wiping any given manifest.requirements.


## 2.6.0

- Change '-v, --verbose' option to mean *debug*-level logging (instead of
  trace-level in v2.3.0-v2.5.0). Also add support for the
  `IMGADM_LOG_LEVEL=<log level name>` environment variable, e.g.

        IMGADM_LOG_LEVEL=trace imgadm create ...

  Supported log level names are: trace, debug, info, warn (default), error,
  fatal.

- Improve debug logging for `imgadm create`.

## 2.5.0

- [OS-2600] `imgadm create -i ...` using a VM created from an *incremental*
  image explicitly fails with NotSupported.

- [OS-2550] `imgadm create -s <prepare-image-script> ...` support to automatic
  running of a preparation script, gated by VM snapshotting and rollback for
  safety. This makes image creation easier (fewer steps, do not need to
  manually prepare and stop the VM) and safer (snapshot/rollback ensures an
  unchanged and usable original VM on completion).

## 2.4.0

- Add `imgadm update [UUID...]` support for updating specific image uuids.

- [OS-2490] `imgadm update` should ensure imported images' snapshot is named
  `@final`

- [OS-1999] `imgadm update` on already installed image should re-fetch manifest
  for mutable field changes

## 2.3.1

- [OS-2487] 'imgadm import' will now not complain about not being able to
  delete -partial dataset on rollback (because sometimes it really isn't
  there yet).

- [OS-2488] Incremental imgadm creation (`imgadm create -i`) will not explicitly
  fail if the origin image does not have a '@final' snapshot on the origin image.
  Images installed with imgadm v2.0.3 or later will have this but images installed
  prior to that may not.

- [OS-2489] `imgadm create` will now properly fail (exit non-zero) on a failure
  of the `zfs send` command it is using internally. Previously in some cases it
  would not.

## 2.3.0

- [OS-2410] KVM support for 'imgadm create'.

- Drop the need for multiple '-v|--verbose' options to increase levels of
  verbosity. There is now the default logging output and verbose output (one or
  any number of '-v').


## 2.2.0

- [IMGAPI-124] Incremental image support. `imgadm create -i ...` will create
  an incremental image, i.e. an image that depends on the image used to
  create the source VM. This is called the "origin" and is stored on the
  `origin` field in the created image manifest.

  `imgadm import` and `imgadm install` now ensure that an image's origin is
  installed before the image itself is installed. `imgadm import` will attempt
  to automatically fetch the origin from current image sources.


## 2.1.1

- [OS-2315] Change from manually DNS resolving source URL hostnames and not
  checking SSL certificates, to *not* resolving hostnames (leave it to the
  OS) and checking SSL certificates. This is safer, but does mean that
  usage of custom imgadm sources over HTTPS and without a valid cert will
  fail. This can be worked around with the new `IMGADM_INSECURE=1`
  environment variable.

  This fixes a bug in 2.1.0 where https sources would always fail SSL
  certificate checks.


## 2.1.0

- [IMGAPI-95] Add 'imgadm publish' to publish a created image to an image
  repository (an IMGAPI). This command is currently *experimental* because
  it is incomplete and not fully vetted.

- [IMGAPI-95] Add 'imgadm create' to create a virtual image from a prepared
  VM. This is still not finalized. Creation of zvol images (i.e. for KVM VMs)
  is not yet supported. This command is currently *experimental* because
  it is incomplete and not fully vetted.


## 2.0.6

- Change to node-progbar for progress bars.


## 2.0.5

- [OS-2274] Fix `imgadm avail` to not crash if there was a problem accessing
  one or more of the sources. Also improve `imgadm avail` to show results
  from working sources even if one or more are not working.

## 2.0.4

- [OS-2218] Correct `imgadm list` to be able to list images with an origin,
  i.e. incremental images.

## 2.0.3

- [IMGAPI-152, smartos-live#204] Ensure that there is a '@final' snapshot
  of an imported image.

## 2.0.2

- `NoSourcesError: imgadm has no configured sources` now only raised for commands
  that need to use the source URLs.
- DNS resolution of source hosts is done lazily, so can `imgadm install` for example
  without internet access.

## 2.0.1

First version for this this changelog maintained.
