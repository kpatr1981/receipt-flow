"""Local web UI (127.0.0.1 only). Nothing leaves the machine."""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys

from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from . import pipeline

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 400 * 1024 * 1024
STATIC = pipeline.ROOT / "receiptflow" / "static"


def _job(job_id: str):
    if not re.fullmatch(r"[0-9a-f]{12}", job_id):
        abort(404)
    job = pipeline.JOBS / job_id
    if not job.is_dir():
        abort(404)
    return job


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.post("/api/photos")
def photos():
    files = request.files.getlist("photos")
    if not files:
        return jsonify(error="No photos received"), 400
    job = pipeline.new_job()
    seen, skipped = {}, []
    for i, f in enumerate(files):
        name = secure_filename(f.filename or "") or f"photo{i}.jpg"
        data = f.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen:
            skipped.append({"photo": f.filename or name, "same_as": seen[digest]})
            continue
        seen[digest] = f.filename or name
        (job / "photos" / f"{i:02d}_{name}").write_bytes(data)
    rows = pipeline.scan_job(job)
    return jsonify(job=job.name, receipts=rows, photos=pipeline.photo_names(job), skipped=skipped)


@app.post("/api/manual/<job_id>")
def manual(job_id):
    job = _job(job_id)
    try:
        return jsonify(receipt=pipeline.add_manual(job, request.get_json()["photo"]))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@app.post("/api/preview/<job_id>")
def preview(job_id):
    job = _job(job_id)
    rows = [r for r in request.get_json()["receipts"] if r.get("date") and r.get("amount") not in (None, "")]
    try:
        months = pipeline.export(job, rows, out_dir=job / "preview", name=request.get_json().get("name", ""))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(months=months)


@app.post("/api/export/<job_id>")
def export(job_id):
    job = _job(job_id)
    rows = [r for r in request.get_json()["receipts"] if not r.get("skip")]
    unverified = [r["id"] for r in rows if not r.get("verified")]
    if unverified:
        return jsonify(error=f"{len(unverified)} receipt(s) are not verified yet"), 400
    try:
        months = pipeline.export(job, rows, name=request.get_json().get("name", ""))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(months=months, folder=str(pipeline.OUTPUT))


@app.post("/api/open-output")
def open_output():
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    subprocess.Popen([opener, str(pipeline.OUTPUT)])
    return jsonify(ok=True)


@app.get("/job/<job_id>/crop/<rid>.jpg")
def crop(job_id, rid):
    return send_from_directory(_job(job_id) / "crops", secure_filename(rid) + ".jpg")


@app.get("/job/<job_id>/<name>")
def job_file(job_id, name):
    return send_from_directory(_job(job_id), secure_filename(name))


@app.get("/output/<name>")
def output_file(name):
    return send_from_directory(pipeline.OUTPUT, secure_filename(name), as_attachment=True)
