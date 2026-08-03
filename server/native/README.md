# server/native

The two C++ components WebDAQ builds on, pinned as **git submodules**:

| Path | Repository | What it is |
|------|-----------|------------|
| `caendaq/` | [skowrons94/CaenDAQ](https://github.com/skowrons94/CaenDAQ) | The acquisition backend (`import caendaq`) — reads the boards, writes `.caendat`, decodes online spectra |
| `rureader/` | [skowrons94/RUReader](https://github.com/skowrons94/RUReader) | Offline `.caendat` → ROOT converter (installed as `/usr/local/bin/RUReader`) |

Together they replace the old XDAQ + Docker + LunaSpy/RUSpy chain. The
`.caendat` **file format** is unchanged — it keeps the XDAQ header layout on
purpose, so runs from any version of WebDAQ convert with the same RUReader.

## Checking them out

A fresh clone needs the submodules initialised:

```bash
git clone --recurse-submodules <WebDAQ url>
# or, in an existing checkout:
git submodule update --init --recursive
```

`./install.sh` does this for you (step 1) and then builds both. If the
submodules are unavailable (e.g. a downloaded tarball), the installer falls
back to standalone checkouts next to WebDAQ — set `LUNA_SRC_DIR` to choose
where.

## Updating a pinned version

The superproject records one commit per submodule; that pin is what makes a
given WebDAQ revision reproducible. To move to a newer upstream:

```bash
git -C server/native/caendaq pull origin main
git add server/native/caendaq
git commit -m "chore: bump CaenDAQ"
```

## Building by hand

`install.sh` installs `caendaq` into the active conda environment with
`pip install server/native/caendaq` (scikit-build-core drives CMake). To
(re)build just the module during development:

```bash
cmake -S server/native/caendaq -B server/native/caendaq/build \
      -DCAENDAQ_BUILD_PYTHON=ON -DCAENDAQ_WITH_CAEN=ON \
      -Dpybind11_DIR="$(python -m pybind11 --cmakedir)"
cmake --build server/native/caendaq/build -j
install -m 755 server/native/caendaq/build/caendaq*.so \
        "$(python -c 'import site; print(site.getsitepackages()[0])')/"
```

Drop `-DCAENDAQ_WITH_CAEN=ON` to build a **mock-only** module (works with
`TEST_FLAG=True`, no CAEN hardware or `libCAENDigitizer` needed).

RUReader needs ROOT:

```bash
cmake -S server/native/rureader -B server/native/rureader/build
cmake --build server/native/rureader/build -j
```

**Build it in the same environment the server runs in.** RUReader links the ROOT
that CMake found at build time, and at startup ROOT looks for the compiler it was
built with in order to locate the C++ standard headers. If RUReader was built in
one conda environment and the server runs in another, that compiler is missing
and ROOT prints:

```
ERROR in cling::CIFactory::createCI(): cannot extract standard library include paths!
```

The conversion still completes — RUReader uses compiled ROOT I/O, not the
interpreter, so the ROOT file is written correctly — but to silence it either
rebuild RUReader in the server's environment (`./install.sh` does this) or point
the server at the environment providing RUReader's ROOT:

```bash
export RUREADER_ENV_PREFIX=/path/to/that/conda/env
```

## Multi-board synchronisation

Synchronisation lives in the **board registers**, not in a WebDAQ setting: a
board whose Acquisition Control (`0x8100`) start mode is *first trigger* is
armed rather than started, and once every board is armed the master (board
register id 0) fires a software trigger that walks the TRG-OUT → TRG-IN chain.

Set it per board from the **Acquisition Control** card in the CAEN dashboard.
See `caendaq/README.md` for the register-level detail.
