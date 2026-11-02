"""Request log, good/bad ratings, statistics and the last-n summary (no photos needed)."""
import pytest

from receiptflow import api, backlog, feedback_cli

R = lambda conf, code=True: {"date": "2026-10-01", "amount": 10.0, "from_code": code, "confidence": conf}


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("RECEIPTFLOW_DB", str(tmp_path / "requests.sqlite3"))


def test_log_rate_and_backlog():
    a = backlog.log_request("rest", [{"file": "a.jpg", "receipts": [R(0.99), R(0.5, False)]}])
    b = backlog.log_request("mcp", [{"file": "b.jpg", "receipts": [], "error": "Not a readable image: b.jpg"}])
    assert a != b
    assert [r["request_id"] for r in backlog.backlog()] == [b, a]
    got = backlog.rate(a, "Bad", "second amount wrong")
    assert (got["rating"], got["note"], got["results"][0]["file"]) == ("bad", "second amount wrong", "a.jpg")
    assert [r["request_id"] for r in backlog.backlog()] == [b]
    assert backlog.rate(a, "good")["rating"] == "good"  # rating again replaces it
    with pytest.raises(ValueError):
        backlog.rate(a, "meh")
    with pytest.raises(KeyError):
        backlog.rate("nope", "good")


def test_stats_and_summary():
    ids = [backlog.log_request("rest", [{"file": f"{i}.jpg", "receipts": [R(c)]}]) for i, c in enumerate([0.99, 0.99, 0.5, 0.0])]
    backlog.rate(ids[0], "good")
    backlog.rate(ids[1], "good")
    backlog.rate(ids[2], "bad")
    s = backlog.stats()
    assert s["total"] == {"requests": 4, "rated": 3, "good": 2, "bad": 1, "good_pct": 66.7, "unrated": 1}
    assert s["by_lowest_confidence"]["0.99 (all from code)"]["good_pct"] == 100.0
    assert s["by_lowest_confidence"]["0.01-0.59"]["bad"] == 1
    assert backlog.summary() == {"last_n": None, "requests": 4, "verified": 3, "good": 2, "bad": 1,
                                 "success_pct": 66.7, "pending_in_window": 1, "pending_total": 1}
    # last 2 = ids[3] (unrated) and ids[2] (bad)
    assert backlog.summary(2) == {"last_n": 2, "requests": 2, "verified": 1, "good": 0, "bad": 1,
                                  "success_pct": 0.0, "pending_in_window": 1, "pending_total": 1}


def test_rest_feedback_endpoints():
    c = api.app.test_client()
    rid = backlog.log_request("rest", [{"file": "a.jpg", "receipts": [R(0.99)]}])
    assert c.get("/v1/requests").json["requests"][0]["request_id"] == rid
    assert c.get(f"/v1/requests/{rid}").json["rating"] is None
    assert c.get("/v1/requests/nope").status_code == 404
    assert c.post(f"/v1/requests/{rid}/feedback", json={"rating": "nah"}).status_code == 400
    assert c.post("/v1/requests/nope/feedback", json={"rating": "good"}).status_code == 404
    r = c.post(f"/v1/requests/{rid}/feedback", json={"rating": "good", "note": "spot on"})
    assert (r.status_code, r.json["rating"], r.json["note"]) == (200, "good", "spot on")
    assert c.get("/v1/requests").json["requests"] == []
    assert c.get("/v1/requests?all=1").json["requests"][0]["rating"] == "good"
    assert c.get("/v1/stats").json["total"]["good"] == 1
    assert c.get("/v1/summary?n=10").json["success_pct"] == 100.0
    assert c.get("/v1/summary").json["pending_total"] == 0
    assert c.get("/v1/summary?n=0").status_code == 400
    assert c.get("/v1/summary?n=x").status_code == 400


def test_feedback_cli(capsys):
    rid = backlog.log_request("mcp", [{"file": "a.jpg", "receipts": [R(0.7)]}])
    assert feedback_cli.main(["list"]) == 0
    assert rid in capsys.readouterr().out
    assert feedback_cli.main(["rate", rid, "bad", "date", "wrong"]) == 0
    assert "BAD (date wrong)" in capsys.readouterr().out
    assert feedback_cli.main(["rate", "nope", "good"]) == 1
    feedback_cli.main(["summary", "5"])
    out = capsys.readouterr().out
    assert "1 verified (0 good, 1 bad) -> success 0.0%" in out and "0 of these, 0 overall" in out
    assert feedback_cli.main(["stats"]) == 0
