#!/bin/sh
# Start Receipt Flow (local web UI). Pass photo paths to run without the UI.
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python -m receiptflow "$@"
