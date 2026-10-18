# @driftengine/assets

Model readers, the loader that streams a `.drft` file onto the screen, and the textures a phone
samples.

**Cost: 28.8 KB gzipped on top of core.** Measured by `scripts/size-gate.test.mjs`, which fails if it
drifts more than 3% — the number is a fact about the build rather than a claim in a document.

- **Readers.** glTF and GLB, OBJ, STL, USD and 3MF, and experimentally FBX and Blender's `.blend`,
  read from the file's own DNA. `readModel` picks the reader by extension and `MODEL_FORMATS` lists
  what each one promises.
- **`DrftLoader`** streams a container nearest first: an outline, then parts within a frame budget,
  then images decoded off the main thread, with progress that reaches ready only once the picture is
  right. A BC texture goes up as its blocks wherever the device samples BC.
- **Phones.** On a device that samples ETC2 and not BC, a BC texture is shown decoded first and then
  re-encoded as ETC2 or EAC in a worker and swapped in behind the handle it was drawn with — half a
  byte a texel for colour, where the decoded image holds four. Pass `bcWorker: spawnBcWorker`, from
  `@driftengine/assets/bcWorkers`; without a worker nothing is encoded and the textures stay RGBA.
  The encode costs about 0.7 s for a 2048² image on a desktop processor, and several times that on a
  phone's, on a core of its own.
- **Textures compressed offline.** `readKtx2` takes an uncompressed KTX2 file — ASTC, ETC2, EAC or
  BC — as the blocks it carries, for `createSurfaceTexture`. `encodeEtc2Chain` makes an ETC2 or EAC
  chain from pixels a caller holds; run it in a worker.
- **The way back out.** `drftToGlb` writes what `readDrft` returns as a glTF 2.0 binary, so a baked
  character or level opens in Blender with its bone names, attachment points, clips and lamps, and
  bakes back to the same `.drft`: what glTF has no field for rides in `extras.drift` records that
  `readModel` returns as `ModelImport.carried`. `npm run export` is the command, and
  [`docs/FORMAT.md`](../../docs/FORMAT.md) §3.4 lists what is exact, what rounds and what is refused.
- **The bake as a function.** `bakeModel` is everything `npm run bake` does between reading a model
  and writing a container — weld, tangents, copies found again, the outline, the pictures — so a
  test or a host with no filesystem bakes the way the command does rather than a copy of it.

Part of [DriftEngine](../../README.md). See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
for how the packages divide, and [`docs/HANDBOOK.md`](../../docs/HANDBOOK.md) for working with
imported models.
