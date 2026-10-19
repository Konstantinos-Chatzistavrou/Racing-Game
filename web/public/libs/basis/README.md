# Basis Universal transcoder

`basis_transcoder.js` + `basis_transcoder.wasm`: copied unchanged from
`node_modules/three/examples/jsm/libs/basis/` (three 0.186.1). KTX2Loader (web/src/scene/loaders.ts)
loads them from `/libs/basis/` to transcode KTX2 (ETC1S / UASTC) textures in workers.
Basis Universal, Apache-2.0 (https://github.com/BinomialLLC/basis_universal).
Re-copy when three is upgraded (the transcoder and KTX2Loader must match).
