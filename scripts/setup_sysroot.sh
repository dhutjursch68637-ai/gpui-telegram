#!/usr/bin/env bash
# scripts/setup_sysroot.sh — Idempotent non-root Debian 12 sysroot & wasm32 rust-std bootstrap
# Can be executed (`./scripts/setup_sysroot.sh`) or sourced (`source ./scripts/setup_sysroot.sh`).

SYSROOT="${GPUI_LOCAL_SYSROOT:-/home/antigravity/.local-sysroot}"
RUST_SYSROOT="${SYSROOT}/rust-sysroot"
RUSTC_WRAP="${SYSROOT}/usr/bin/gpui-rustc-wrap"
STAMP_FILE="${SYSROOT}/.sysroot_ready_v1"
CARGO_HOME_DIR="${CARGO_HOME:-${HOME}/.cargo}"
CARGO_HOME_CFG="${CARGO_HOME_DIR}/config.toml"

_gpui_build_rustc_wrapper() {
  mkdir -p "${SYSROOT}/usr/bin"
  local tmp_c="/dev/shm/gpui_rustc_wrap_$$.c"
  cat > "${tmp_c}" <<EOF
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        return 1;
    }
    const char *rustc_bin = argv[1];
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "-vV") == 0 || strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "-V") == 0) {
            execvp(rustc_bin, &argv[1]);
            perror("execvp rustc");
            return 127;
        }
    }

    int seen_sysroot = 0;
    int is_wasm_target = 0;
    int seen_sysroot_lib = 0;

    char **out = calloc((size_t)argc + 16, sizeof(char *));
    if (!out) {
        return 1;
    }
    int n = 0;
    out[n++] = (char *)rustc_bin;

    for (int i = 2; i < argc; i++) {
        char *a = argv[i];
        if (strncmp(a, "--sysroot=", 10) == 0) {
            if (!seen_sysroot) {
                seen_sysroot = 1;
                out[n++] = a;
            }
            continue;
        }
        if (strcmp(a, "--sysroot") == 0 && i + 1 < argc) {
            if (!seen_sysroot) {
                seen_sysroot = 1;
                out[n++] = a;
                out[n++] = argv[i + 1];
            }
            i++;
            continue;
        }
        if (strncmp(a, "--target=wasm32", 15) == 0) {
            is_wasm_target = 1;
        } else if (strcmp(a, "--target") == 0 && i + 1 < argc && strncmp(argv[i + 1], "wasm32", 6) == 0) {
            is_wasm_target = 1;
        }
        if (strstr(a, ".local-sysroot/usr/lib/x86_64-linux-gnu") != NULL) {
            seen_sysroot_lib = 1;
        }
        out[n++] = a;
    }

    if (!seen_sysroot && access("${RUST_SYSROOT}/lib/rustlib", F_OK) == 0) {
        out[n++] = "--sysroot=${RUST_SYSROOT}";
    }

    if (!is_wasm_target && !seen_sysroot_lib && access("${SYSROOT}/usr/bin/mold", X_OK) == 0) {
        out[n++] = "-C";
        out[n++] = "link-arg=-B${SYSROOT}/usr/bin";
        out[n++] = "-C";
        out[n++] = "link-arg=-fuse-ld=mold";
        out[n++] = "-L";
        out[n++] = "native=${SYSROOT}/usr/lib/x86_64-linux-gnu";
        out[n++] = "-C";
        out[n++] = "link-arg=-Wl,--disable-new-dtags";
        out[n++] = "-C";
        out[n++] = "link-arg=-Wl,-rpath,${SYSROOT}/usr/lib/x86_64-linux-gnu";
    }

    out[n] = NULL;
    execvp(rustc_bin, out);
    perror("execvp rustc");
    return 127;
}
EOF
  clang -O2 "${tmp_c}" -o "${RUSTC_WRAP}.tmp.$$"
  rm -f "${tmp_c}"
  chmod +x "${RUSTC_WRAP}.tmp.$$"
  mv -f "${RUSTC_WRAP}.tmp.$$" "${RUSTC_WRAP}"
}

_gpui_ensure_cargo_home_config() {
  mkdir -p "${CARGO_HOME_DIR}"
  local protoc_bin="/usr/bin/protoc"
  if [ -x "${SYSROOT}/usr/bin/protoc" ]; then
    protoc_bin="${SYSROOT}/usr/bin/protoc"
  fi
  local desired
  desired="$(cat <<EOF
# Managed idempotently by gpui-telegram/scripts/setup_sysroot.sh
# Intentionally omits [build] target-dir so --manifest-path works cleanly from any Cwd.

[build]
rustc-wrapper = "${RUSTC_WRAP}"

[registries.crates-io]
protocol = "sparse"

[net]
retry = 3
git-fetch-with-cli = false

[env]
PKG_CONFIG_PATH = "${SYSROOT}/usr/lib/x86_64-linux-gnu/pkgconfig:${SYSROOT}/usr/share/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig:"
CPATH = "${SYSROOT}/usr/include:${SYSROOT}/usr/include/libdrm"
C_INCLUDE_PATH = "${SYSROOT}/usr/include:${SYSROOT}/usr/include/libdrm"
CPLUS_INCLUDE_PATH = "${SYSROOT}/usr/include:${SYSROOT}/usr/include/libdrm"
LIBRARY_PATH = "${SYSROOT}/usr/lib/x86_64-linux-gnu"
LIBCLANG_PATH = "${SYSROOT}/usr/lib/llvm-14/lib"
PROTOC = "${protoc_bin}"

[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = [
  "-C", "link-arg=-B${SYSROOT}/usr/bin",
  "-C", "link-arg=-fuse-ld=mold",
  "-L", "native=${SYSROOT}/usr/lib/x86_64-linux-gnu",
  "-C", "link-arg=-Wl,--disable-new-dtags",
  "-C", "link-arg=-Wl,-rpath,${SYSROOT}/usr/lib/x86_64-linux-gnu",
]

[target.wasm32-unknown-unknown]
rustflags = ["--sysroot=${RUST_SYSROOT}"]
EOF
)"
  if [ -f "${CARGO_HOME_CFG}" ] && [ "$(cat "${CARGO_HOME_CFG}")" = "${desired}" ]; then
    return 0
  fi
  printf '%s\n' "${desired}" > "${CARGO_HOME_CFG}"
}

_gpui_populate_sysroot() {
  set -euo pipefail

  if [ -f "${STAMP_FILE}" ] \
    && [ -x "${SYSROOT}/usr/bin/mold" ] \
    && [ -x "${RUSTC_WRAP}" ] \
    && [ -f "${SYSROOT}/usr/lib/x86_64-linux-gnu/pkgconfig/libpipewire-0.3.pc" ] \
    && [ -d "${RUST_SYSROOT}/lib/rustlib/wasm32-unknown-unknown/lib" ]; then
    _gpui_build_rustc_wrapper
    _gpui_ensure_cargo_home_config
    echo "[setup_sysroot] Sysroot already populated at ${SYSROOT}"
    return 0
  fi

  echo "[setup_sysroot] Populating non-root sysroot at ${SYSROOT} ..."
  local work_dir="/dev/shm/gpui_sysroot_build_$$"
  trap "rm -rf '${work_dir}'" EXIT
  mkdir -p "${work_dir}/apt/lists/partial" \
           "${work_dir}/apt/cache/archives/partial" \
           "${work_dir}/apt/state" \
           "${work_dir}/debs" \
           "${SYSROOT}"

  local apt_opts=(
    -o "Dir::State=${work_dir}/apt/state"
    -o "Dir::State::status=/var/lib/dpkg/status"
    -o "Dir::State::lists=${work_dir}/apt/lists"
    -o "Dir::Cache=${work_dir}/apt/cache"
    -o "Dir::Cache::archives=${work_dir}/apt/cache/archives"
    -o "APT::Update::Pre-Invoke::="
    -o "APT::Update::Post-Invoke::="
    -o "Acquire::Languages=none"
    -o "Debug::NoLocking=1"
  )

  apt-get "${apt_opts[@]}" update

  # Top-level native build & link packages needed beyond base VM installation;
  # apt-get install --print-uris resolves all missing transitive -dev AND runtime .so.* debs.
  local pkgs=(
    mold
    libclang-dev
    libpipewire-0.3-dev
    libspa-0.2-dev
    libgbm-dev
    libdrm-dev
    libxcb-shape0-dev
    libxcb-xfixes0-dev
    libxcb-randr0-dev
    libxcb-composite0-dev
    libxcb-xkb-dev
    libx11-xcb-dev
    libxkbcommon-x11-dev
    libvulkan-dev
    libasound2-dev
  )

  apt-get "${apt_opts[@]}" install --print-uris -qq --no-install-recommends "${pkgs[@]}" > "${work_dir}/uris.txt"

  while read -r uri fname _size _hash; do
    uri="${uri#\'}"
    uri="${uri%\'}"
    [ -z "${uri}" ] && continue
    curl -fsSL "${uri}" -o "${work_dir}/debs/${fname}"
    dpkg-deb -x "${work_dir}/debs/${fname}" "${SYSROOT}"
  done < "${work_dir}/uris.txt"

  # Repair both relative and absolute symlinks inside SYSROOT whose targets live in SYSROOT or host /usr
  for _pass in 1 2; do
    while IFS= read -r -d '' link; do
      if [ ! -e "${link}" ]; then
        local target link_dir host_dir cand_host
        target="$(readlink "${link}")"
        link_dir="$(dirname "${link}")"
        host_dir="${link_dir#"${SYSROOT}"}"
        if [[ "${target}" == /* ]]; then
          if [ -e "${SYSROOT}${target}" ]; then
            ln -snf "${SYSROOT}${target}" "${link}"
          elif [ -e "${target}" ]; then
            ln -snf "${target}" "${link}"
          elif [ -e "/usr${target}" ]; then
            ln -snf "/usr${target}" "${link}"
          fi
        else
          cand_host="$(realpath -m "${host_dir}/${target}")"
          if [ -e "${SYSROOT}${cand_host}" ]; then
            ln -snf "${SYSROOT}${cand_host}" "${link}"
          elif [ -e "${cand_host}" ]; then
            ln -snf "${cand_host}" "${link}"
          elif [ -e "/usr${cand_host}" ]; then
            ln -snf "/usr${cand_host}" "${link}"
          fi
        fi
      fi
    done < <(find "${SYSROOT}/usr" -type l -print0)
  done

  # Rewrite pkg-config prefixes inside SYSROOT only (NEVER set PKG_CONFIG_SYSROOT_DIR)
  while IFS= read -r -d '' pc; do
    sed -i \
      -e "s|^prefix=/usr$|prefix=${SYSROOT}/usr|g" \
      -e "s|^libdir=/usr/|libdir=${SYSROOT}/usr/|g" \
      -e "s|^includedir=/usr/|includedir=${SYSROOT}/usr/|g" \
      "${pc}"
  done < <(find "${SYSROOT}/usr" -name "*.pc" -print0)

  # Populate overlay Rust toolchain sysroot with wasm32-unknown-unknown rust-std
  # (Works cleanly even when /usr/local/rustup is mounted EROFS / read-only)
  local host_tc
  host_tc="$(rustc --print sysroot)"
  rm -rf "${RUST_SYSROOT}"
  mkdir -p "${RUST_SYSROOT}/lib/rustlib"
  for item in "${host_tc}"/*; do
    local base
    base="$(basename "${item}")"
    [ "${base}" = "lib" ] && continue
    ln -snf "${item}" "${RUST_SYSROOT}/${base}"
  done
  for item in "${host_tc}/lib"/*; do
    local base
    base="$(basename "${item}")"
    [ "${base}" = "rustlib" ] && continue
    ln -snf "${item}" "${RUST_SYSROOT}/lib/${base}"
  done
  for item in "${host_tc}/lib/rustlib"/*; do
    local base
    base="$(basename "${item}")"
    ln -snf "${item}" "${RUST_SYSROOT}/lib/rustlib/${base}"
  done

  if [ -d "${host_tc}/lib/rustlib/wasm32-unknown-unknown/lib" ]; then
    ln -snf "${host_tc}/lib/rustlib/wasm32-unknown-unknown" "${RUST_SYSROOT}/lib/rustlib/wasm32-unknown-unknown"
  else
    local manifest="${host_tc}/lib/rustlib/multirust-channel-manifest.toml"
    local wasm_url wasm_sha actual_sha
    read -r wasm_url wasm_sha < <(python3 - "${manifest}" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as f:
    m = tomllib.load(f)
w = m["pkg"]["rust-std"]["target"]["wasm32-unknown-unknown"]
print(w["xz_url"], w["xz_hash"])
PY
)
    echo "[setup_sysroot] Downloading wasm32-unknown-unknown rust-std from ${wasm_url} ..."
    curl -fsSL "${wasm_url}" -o "${work_dir}/rust-std-wasm32.tar.xz"
    actual_sha="$(sha256sum "${work_dir}/rust-std-wasm32.tar.xz" | awk '{print $1}')"
    if [ "${actual_sha}" != "${wasm_sha}" ]; then
      echo "[setup_sysroot] ERROR: SHA256 mismatch for rust-std-wasm32 (${actual_sha} != ${wasm_sha})" >&2
      return 1
    fi
    mkdir -p "${work_dir}/wasm_std"
    tar -xJf "${work_dir}/rust-std-wasm32.tar.xz" -C "${work_dir}/wasm_std"
    cp -a "${work_dir}"/wasm_std/rust-std-*-wasm32-unknown-unknown/rust-std-wasm32-unknown-unknown/lib/rustlib/wasm32-unknown-unknown \
      "${RUST_SYSROOT}/lib/rustlib/wasm32-unknown-unknown"
  fi

  _gpui_build_rustc_wrapper
  _gpui_ensure_cargo_home_config

  rm -rf "${work_dir}"
  trap - EXIT
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "${STAMP_FILE}"
  echo "[setup_sysroot] Ready: ${SYSROOT}"
}

_gpui_export_env() {
  local protoc_bin="/usr/bin/protoc"
  if [ -x "${SYSROOT}/usr/bin/protoc" ]; then
    protoc_bin="${SYSROOT}/usr/bin/protoc"
  fi
  export GPUI_LOCAL_SYSROOT="${SYSROOT}"
  export PATH="${SYSROOT}/usr/bin:${PATH}"
  export PKG_CONFIG_PATH="${SYSROOT}/usr/lib/x86_64-linux-gnu/pkgconfig:${SYSROOT}/usr/share/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig:"
  export CPATH="${SYSROOT}/usr/include:${SYSROOT}/usr/include/libdrm${CPATH:+:${CPATH}}"
  export C_INCLUDE_PATH="${SYSROOT}/usr/include:${SYSROOT}/usr/include/libdrm${C_INCLUDE_PATH:+:${C_INCLUDE_PATH}}"
  export CPLUS_INCLUDE_PATH="${SYSROOT}/usr/include:${SYSROOT}/usr/include/libdrm${CPLUS_INCLUDE_PATH:+:${CPLUS_INCLUDE_PATH}}"
  export LIBRARY_PATH="${SYSROOT}/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:${LIBRARY_PATH}}"
  export LD_LIBRARY_PATH="${SYSROOT}/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
  export LIBCLANG_PATH="${SYSROOT}/usr/lib/llvm-14/lib"
  export PROTOC="${protoc_bin}"
  export RUSTC_WRAPPER="${RUSTC_WRAP}"
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="clang"
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="-C link-arg=-B${SYSROOT}/usr/bin -C link-arg=-fuse-ld=mold -L native=${SYSROOT}/usr/lib/x86_64-linux-gnu -C link-arg=-Wl,--disable-new-dtags -C link-arg=-Wl,-rpath,${SYSROOT}/usr/lib/x86_64-linux-gnu"
  export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="--sysroot=${RUST_SYSROOT}"
}

if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  ( _gpui_populate_sysroot ) && _gpui_export_env
else
  _gpui_populate_sysroot
fi
