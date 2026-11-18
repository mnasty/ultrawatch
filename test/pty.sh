#!/bin/sh
# usage: test/pty.sh <cols> <rows> <outfile> <keys-script> -- ultrawatch args...
# Runs ultrawatch's TUI inside a real pseudo-terminal (macOS/BSD `script`), feeding keys with delays.
cols=$1; rows=$2; out=$3; keys=$4; shift 4; [ "$1" = "--" ] && shift
dir=$(cd "$(dirname "$0")/.." && pwd)
( eval "$keys" ) | script -q "$out" sh -c "stty cols $cols rows $rows; exec node '$dir/ultrawatch.mjs' $*" >/dev/null 2>&1
