#!/usr/bin/env python3
import argparse
import json
import os
import sys


def price_to_float(value):
    number = float(value)
    if abs(number) > 1_000_000:
        return number / 1_000_000_000
    return number


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-env", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--schema", default="ohlcv-1m")
    parser.add_argument("--stype-in", default="continuous")
    parser.add_argument("--start", required=True)
    parser.add_argument("--end")
    parser.add_argument("--limit", type=int, default=1200)
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

    client = db.Historical(api_key)
    store = client.timeseries.get_range(
        dataset=args.dataset,
        symbols=[args.symbol],
        schema=args.schema,
        stype_in=args.stype_in,
        start=args.start,
        end=args.end,
        limit=args.limit,
    )
    frame = store.to_df()
    if frame.empty:
        print(json.dumps({"candles": [], "rows": 0}))
        return

    rows = []
    for index, row in frame.reset_index().iterrows():
        ts_value = row["ts_event"] if "ts_event" in row else row.iloc[0]
        timestamp = ts_value.isoformat() if hasattr(ts_value, "isoformat") else str(ts_value)
        rows.append(
            {
                "timestamp": timestamp,
                "open": price_to_float(row["open"]),
                "high": price_to_float(row["high"]),
                "low": price_to_float(row["low"]),
                "close": price_to_float(row["close"]),
            }
        )

    print(json.dumps({"candles": rows, "rows": len(rows)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
