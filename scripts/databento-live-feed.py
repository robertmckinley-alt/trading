#!/usr/bin/env python3
"""Stream Databento live OHLCV bars into one shared, atomic JSON cache."""

import argparse
import json
import os
import signal
import sys
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path


PRICE_SCALE = 1_000_000_000


def price_to_float(value):
    number = float(value)
    return number / PRICE_SCALE if abs(number) > 1_000_000 else number


def timestamp_to_iso(value):
    nanoseconds = int(value)
    return datetime.fromtimestamp(nanoseconds / 1_000_000_000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_write_json(output_path, payload):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.{os.getpid()}.tmp")
    temporary_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary_path, output_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-env", default="DATABENTO_API_KEY")
    parser.add_argument("--dataset", default="GLBX.MDP3")
    parser.add_argument("--symbol", default="NQ.v.0")
    parser.add_argument("--schema", default="ohlcv-1m")
    parser.add_argument("--stype-in", default="continuous")
    parser.add_argument("--output", default="runtime/databento-live.json")
    parser.add_argument("--replay-hours", type=float, default=23)
    parser.add_argument("--max-bars", type=int, default=1600)
    args = parser.parse_args()

    api_key = os.environ.get(args.key_env)
    if not api_key:
        raise RuntimeError(f"Missing {args.key_env} environment variable")

    try:
        import databento as db
    except ImportError as exc:
        raise RuntimeError(
            "Missing Python package 'databento'. Install it with: python3 -m pip install databento"
        ) from exc

    output_path = Path(args.output).resolve()
    bars = OrderedDict()
    started_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    client = db.Live(key=api_key, reconnect_policy="reconnect")

    def write_cache():
        candles = list(bars.values())[-max(1, args.max_bars):]
        latest_at = candles[-1]["timestamp"] if candles else None
        atomic_write_json(output_path, {
            "mode": "live",
            "provider": "databento-live",
            "dataset": args.dataset,
            "symbol": args.symbol,
            "schema": args.schema,
            "stypeIn": args.stype_in,
            "startedAt": started_at,
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "latestCandleAt": latest_at,
            "candles": candles,
        })

    def on_record(record):
        required = ("ts_event", "open", "high", "low", "close")
        if not all(hasattr(record, name) for name in required):
            return
        timestamp = timestamp_to_iso(record.ts_event)
        bars[timestamp] = {
            "timestamp": timestamp,
            "open": price_to_float(record.open),
            "high": price_to_float(record.high),
            "low": price_to_float(record.low),
            "close": price_to_float(record.close),
            "volume": int(getattr(record, "volume", 0)),
        }
        bars.move_to_end(timestamp)
        while len(bars) > max(1, args.max_bars):
            bars.popitem(last=False)
        write_cache()

    def on_exception(error):
        print(f"Databento live stream error: {error}", file=sys.stderr, flush=True)

    def stop_stream(_signum=None, _frame=None):
        client.stop()

    signal.signal(signal.SIGTERM, stop_stream)
    signal.signal(signal.SIGINT, stop_stream)
    replay_start = (
        datetime.now(timezone.utc) - timedelta(hours=min(max(args.replay_hours, 0), 23.9))
    ).replace(second=0, microsecond=0)

    client.add_callback(on_record, on_exception)
    client.subscribe(
        dataset=args.dataset,
        schema=args.schema,
        symbols=[args.symbol],
        stype_in=args.stype_in,
        start=replay_start,
    )
    print(
        f"Streaming live {args.dataset} {args.symbol} {args.schema} from {replay_start.isoformat()} into {output_path}",
        flush=True,
    )
    client.start()
    client.block_for_close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Databento live feed failed: {exc}", file=sys.stderr)
        sys.exit(1)
