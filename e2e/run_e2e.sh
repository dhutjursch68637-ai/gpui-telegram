#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(trap -p INT)" == "trap -- '' SIGINT" && -z "${GPUI_E2E_SIGINT_RESET:-}" ]]; then
  export GPUI_E2E_SIGINT_RESET=1
  exec /usr/bin/perl -e '$SIG{INT} = "DEFAULT"; exec "/usr/bin/bash", @ARGV or die $!' "${BASH_SOURCE[0]}" "$@"
fi
unset GPUI_E2E_SIGINT_RESET || true

RUNS_ROOT="${SCRIPT_DIR}/.e2e-runs"
WRAPPER_DIR="${RUNS_ROOT}/w-$$"
WRAPPER_TMP="${WRAPPER_DIR}/t"
NODE_PID=""

mkdir -p "${WRAPPER_TMP}"

cleanup_exit() {
  local exit_code=$?
  if [[ -n "${NODE_PID}" ]] && kill -0 "${NODE_PID}" 2>/dev/null; then
    kill -TERM "${NODE_PID}" 2>/dev/null || true
    wait "${NODE_PID}" 2>/dev/null || true
  fi
  jobs -p | xargs -r kill -TERM 2>/dev/null || true
  rm -rf "${WRAPPER_DIR}" 2>/dev/null || true
  if [[ -n "${NODE_PID}" ]]; then
    rm -rf /dev/shm/gpui-e2e-"${NODE_PID}"-* 2>/dev/null || true
  fi
  rm -rf /dev/shm/gpui-e2e-"$$"-* 2>/dev/null || true
  exit "${exit_code}"
}

handle_int() {
  trap '' INT TERM
  if [[ -n "${NODE_PID}" ]] && kill -0 "${NODE_PID}" 2>/dev/null; then
    kill -INT "${NODE_PID}" 2>/dev/null || true
    wait "${NODE_PID}" 2>/dev/null || true
  fi
  exit 130
}

handle_term() {
  trap '' INT TERM
  if [[ -n "${NODE_PID}" ]] && kill -0 "${NODE_PID}" 2>/dev/null; then
    kill -TERM "${NODE_PID}" 2>/dev/null || true
    wait "${NODE_PID}" 2>/dev/null || true
  fi
  exit 143
}

trap cleanup_exit EXIT
trap handle_int INT
trap handle_term TERM

export TMPDIR="${WRAPPER_TMP}"
export TMP="${WRAPPER_TMP}"
export TEMP="${WRAPPER_TMP}"
export NO_PROXY="localhost,127.0.0.1,::1,[::1]"
export no_proxy="localhost,127.0.0.1,::1,[::1]"
unset GPUI_OFFLINE_TEST || true

set +e
/usr/local/bin/node --no-warnings --experimental-transform-types "${SCRIPT_DIR}/src/runner/cli.ts" "$@" &
NODE_PID=$!
wait "${NODE_PID}"
RC=$?
set -e

exit "${RC}"
