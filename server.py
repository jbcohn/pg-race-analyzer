#!/usr/bin/env python3
"""
Local server and Airtribune race importer for Paragliding Race Analyzer.

Usage:
  1. Run local server (serves UI + provides /api/import-airtribune endpoint):
     python3 server.py [--port 8000]

  2. Import an Airtribune competition or task directly from CLI:
     python3 server.py --import https://airtribune.com/srs-2026-6 --comp "SRS Tapalpa 2026"
"""

import argparse
import html
import io
import json
import os
import re
import shutil
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
TASKS_DIR = os.path.join(ROOT_DIR, "Tasks")
MANIFEST_PATHS = [
    os.path.join(TASKS_DIR, "manifest.json"),
    os.path.join(ROOT_DIR, "manifest.json"),
]

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def fetch_bytes(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_text(url, timeout=45):
    data = fetch_bytes(url, timeout=timeout)
    return data.decode("utf-8", errors="replace")


def strip_accents(text):
    if not text:
        return ""
    norm = unicodedata.normalize("NFKD", text)
    return "".join(c for c in norm if not unicodedata.combining(c))


def clean_pilot_filename(pilot_name, comp_id, orig_filename):
    """
    Create a clean ASCII filename for an IGC file so that main.js formatPilotName()
    and getPilotFullName() extract the pilot's first and last name accurately.
    """
    if pilot_name:
        ascii_name = strip_accents(pilot_name).strip()
        # Normalize spaces and remove non-alphanumeric chars except spaces/hyphens
        ascii_name = re.sub(r"[^A-Za-z\s-]", "", ascii_name)
        words = [w.capitalize() for w in ascii_name.split() if w]
        if words:
            name_part = "_".join(words)
            if comp_id:
                return f"{name_part}_{comp_id}.igc"
            return f"{name_part}.igc"
    return orig_filename


def extract_igc_metadata(igc_text):
    """Extract pilot name and timezone offset from IGC header lines."""
    pilot_name = None
    tz_offset = None
    for line in igc_text.splitlines()[:40]:
        line = line.strip()
        if line.startswith("B"):
            break
        m_plt = re.match(r"^H[FOP]PLT(?:PILOT(?:INCHARGE)?)?\s*:\s*(.+)$", line, re.I)
        if m_plt and not pilot_name:
            val = m_plt.group(1).strip()
            if val and val.upper() != "NA":
                pilot_name = val
        m_tz = re.match(r"^H[FOP]TZ[NO](?:Timezone)?\s*:\s*([+-]?\d+(?:\.\d+)?)", line, re.I)
        if m_tz and tz_offset is None:
            try:
                tz_offset = float(m_tz.group(1))
                if tz_offset.is_integer():
                    tz_offset = int(tz_offset)
            except ValueError:
                pass
    return pilot_name, tz_offset


def parse_airtribune_url(url):
    """
    Parse any Airtribune URL into:
      base_url: e.g. 'https://airtribune.com'
      slug: e.g. 'srs-2026-6'
      specific_task_id: e.g. '6989' or None
    """
    url = url.strip()
    if not url.startswith("http"):
        url = "https://" + url
    parsed = urllib.parse.urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"
    path_parts = [p for p in parsed.path.split("/") if p]
    if not path_parts:
        raise ValueError("Invalid Airtribune URL: missing competition slug")
    slug = path_parts[0]
    specific_task_id = None
    m_task = re.search(r"task(\d+)", parsed.path, re.I)
    if m_task:
        specific_task_id = m_task.group(1)
    return base_url, slug, specific_task_id


def strip_tags(html_str):
    text = re.sub(r"<[^>]+>", "", html_str)
    return html.unescape(text).replace("\xa0", " ").strip()


def parse_task_overall_html(overall_html, fallback_task_name="Task 1", fallback_date=""):
    """
    Parse an Airtribune task OVERALL results page (supports both AirScore and FS HTML tables).
    Returns:
      {
        "task_text": formatted task definition string for main.js drawTask(),
        "pilot_map": { "0040": "Matthijs GROENEVELD", ... },
        "standings_lines": [ "1\t0040\tMatthijs Groeneveld", ... ],
        "startgate": "12:30:00" or None,
        "deadline": "17:00:00" or None,
      }
    """
    turnpoint_rows = []
    pilot_map = {}
    standings_lines = []
    startgate = None
    deadline = None
    race_dist_str = ""

    # Check for explicit Startgate / Deadline text anywhere in the document
    plain_doc = strip_tags(overall_html)
    m_sg = re.search(r"Startgate\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)", plain_doc, re.I)
    if m_sg:
        startgate = m_sg.group(1)
    m_dl = re.search(r"Deadline\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)", plain_doc, re.I)
    if m_dl:
        deadline = m_dl.group(1)

    # Extract all innermost <tr>...</tr> rows (never spanning across nested <tr> tags)
    all_trs = re.findall(r"<tr[^>]*>((?:(?!</?tr\b).)*?)</tr>", overall_html, re.S | re.I)
    sections = []
    current_header = None
    current_rows = []

    for tr_inner in all_trs:
        if "<table" in tr_inner.lower():
            continue
        ths = [strip_tags(c) for c in re.findall(r"<th[^>]*>(.*?)</th>", tr_inner, re.S | re.I)]
        if ths and any(ths):
            if current_header:
                sections.append((current_header, current_rows))
            current_header = [h.lower().strip() for h in ths]
            current_rows = []
        elif current_header is not None:
            tds = [strip_tags(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr_inner, re.S | re.I)]
            if tds and any(tds):
                current_rows.append(tds)

    if current_header:
        sections.append((current_header, current_rows))

    for header, rows in sections:
        # 1. AirScore turnpoint table: Order | Check | Radius | SS/ES | Distance | Name | Description
        if "order" in header and "radius" in header and "name" in header:
            order_idx = header.index("order")
            radius_idx = header.index("radius")
            sses_idx = next((i for i, h in enumerate(header) if "ss" in h or "es" in h), -1)
            dist_idx = next((i for i, h in enumerate(header) if "dist" in h), -1)
            name_idx = header.index("name")
            desc_idx = next((i for i, h in enumerate(header) if "desc" in h), -1)

            for cells in rows:
                if len(cells) <= name_idx:
                    continue
                order_val = cells[order_idx].upper().strip()
                wpt_id = cells[name_idx].strip()
                if not wpt_id:
                    continue
                raw_radius = cells[radius_idx].strip() if radius_idx < len(cells) else ""
                sses_val = cells[sses_idx].upper().strip() if (sses_idx != -1 and sses_idx < len(cells)) else ""
                raw_dist = cells[dist_idx].strip() if (dist_idx != -1 and dist_idx < len(cells)) else "0.0 km"
                desc_val = cells[desc_idx].strip() if (desc_idx != -1 and desc_idx < len(cells)) else wpt_id

                # Normalize radius string
                radius_str = "400 m"
                m_rad = re.search(r"(\d+(?:\.\d+)?)\s*(km|m)", raw_radius, re.I)
                if m_rad:
                    r_val = float(m_rad.group(1))
                    r_unit = m_rad.group(2).lower()
                    if r_unit == "km" and r_val < 1.0:
                        radius_str = f"{int(round(r_val * 1000))} m"
                    elif r_unit == "km":
                        radius_str = f"{r_val:.1f} Km"
                    else:
                        radius_str = f"{int(round(r_val))} m"

                # Normalize distance string
                dist_str = "0.00 Km"
                m_dist = re.search(r"(\d+(?:\.\d+)?)\s*(km|m)", raw_dist, re.I)
                if m_dist:
                    d_val = float(m_dist.group(1))
                    d_unit = m_dist.group(2).lower()
                    if d_unit == "m":
                        d_val = d_val / 1000.0
                    dist_str = f"{d_val:.2f} Km"
                    race_dist_str = f"{d_val:.2f} Km"

                tp_type = ""
                if order_val in ("TO", "TAKEOFF", "LAUNCH"):
                    tp_type = "launch"
                elif sses_val in ("SS", "SSS"):
                    tp_type = "SS"
                elif sses_val in ("ES", "ESS"):
                    tp_type = "ES"
                elif order_val == "GOAL":
                    tp_type = "goal"

                turnpoint_rows.append((wpt_id, tp_type, radius_str, dist_str, desc_val))

                # If GOAL row is marked ES, add an explicit goal row too
                if order_val == "GOAL" and tp_type == "ES":
                    turnpoint_rows.append((wpt_id, "goal", radius_str, dist_str, desc_val))

        # 2. FS turnpoint table: No | Leg Dist. | Id | Radius | Open | Close | Coordinates | Altitude
        elif "id" in header and "radius" in header:
            id_idx = header.index("id")
            radius_idx = header.index("radius")
            no_idx = next((i for i, h in enumerate(header) if h in ("no", "no.")), 0)
            dist_idx = next((i for i, h in enumerate(header) if "dist" in h), -1)
            open_idx = next((i for i, h in enumerate(header) if "open" in h), -1)
            close_idx = next((i for i, h in enumerate(header) if "close" in h), -1)
            desc_idx = next((i for i, h in enumerate(header) if "desc" in h), -1)

            cum_dist = 0.0
            for cells in rows:
                if len(cells) <= max(id_idx, radius_idx):
                    continue
                no_val = cells[no_idx].upper().strip() if no_idx < len(cells) else ""
                wpt_id = cells[id_idx].strip()
                if not wpt_id or wpt_id.lower().startswith("startgate"):
                    continue
                raw_radius = cells[radius_idx].strip()
                raw_dist = cells[dist_idx].strip() if (dist_idx != -1 and dist_idx < len(cells)) else ""
                desc_val = cells[desc_idx].strip() if (desc_idx != -1 and desc_idx < len(cells)) else wpt_id

                # Radius
                radius_str = raw_radius
                m_rad = re.search(r"(\d+(?:\.\d+)?)\s*(km|m)?", raw_radius, re.I)
                if m_rad:
                    r_val = float(m_rad.group(1))
                    r_unit = (m_rad.group(2) or "m").lower()
                    if r_unit == "km":
                        radius_str = f"{r_val:.1f} Km"
                    else:
                        radius_str = f"{int(round(r_val))} m"

                # Distance
                m_dist = re.search(r"(\d+(?:\.\d+)?)", raw_dist)
                if m_dist:
                    d_val = float(m_dist.group(1))
                    if "leg" in header[dist_idx]:
                        cum_dist += d_val
                    else:
                        cum_dist = d_val
                dist_str = f"{cum_dist:.2f} Km"
                race_dist_str = dist_str

                tp_type = ""
                if "SS" in no_val:
                    tp_type = "SS"
                    if open_idx != -1 and open_idx < len(cells) and not startgate:
                        m_t = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?)", cells[open_idx])
                        if m_t:
                            startgate = m_t.group(1)
                elif "ES" in no_val:
                    tp_type = "ES"
                elif no_val == "1" or "TO" in no_val or "LAUNCH" in wpt_id.upper():
                    tp_type = "launch"
                elif "GOAL" in no_val:
                    tp_type = "goal"

                if close_idx != -1 and close_idx < len(cells):
                    m_c = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?)", cells[close_idx])
                    if m_c:
                        deadline = m_c.group(1)

                turnpoint_rows.append((wpt_id, tp_type, radius_str, dist_str, desc_val))

        # 3. Pilot results table: Rank / # | ID | Name | ... | Start | Finish
        elif ("rank" in header or "#" in header) and "name" in header:
            rank_idx = header.index("rank") if "rank" in header else header.index("#")
            id_idx = header.index("id") if "id" in header else -1
            name_idx = header.index("name")
            start_idx = header.index("start") if "start" in header else -1

            start_times = []
            for cells in rows:
                if len(cells) <= name_idx:
                    continue
                rank_str = re.sub(r"[^\d]", "", cells[rank_idx])
                comp_id = cells[id_idx].strip() if (id_idx != -1 and id_idx < len(cells)) else ""
                raw_name = cells[name_idx].strip()
                if not raw_name:
                    continue

                clean_name = " ".join(w.capitalize() for w in strip_accents(raw_name).split())
                if comp_id:
                    pilot_map[comp_id] = clean_name
                    pilot_map[comp_id.lstrip("0") or "0"] = clean_name

                if rank_str:
                    standings_lines.append(f"{rank_str}\t{comp_id or '0'}\t{clean_name}")

                if start_idx != -1 and start_idx < len(cells):
                    st_val = cells[start_idx].strip()
                    if re.match(r"^\d{1,2}:\d{2}:\d{2}$", st_val):
                        start_times.append(st_val)

            if start_times and not startgate:
                # Earliest start time in the race is the first startgate
                startgate = min(start_times)

    # Ensure last turnpoint has a goal entry
    if turnpoint_rows and turnpoint_rows[-1][1] != "goal":
        last = turnpoint_rows[-1]
        if last[1] == "ES":
            turnpoint_rows.append((last[0], "goal", last[2], last[3], last[4]))
        else:
            turnpoint_rows[-1] = (last[0], "goal", last[2], last[3], last[4])

    # Format task text
    lines = [
        fallback_task_name,
        fallback_date or "2026-01-01",
        f"Race {race_dist_str}".strip(),
        "Official Result",
        "id \t\tRadius \tDist. \tDescription",
    ]
    for wpt_id, tp_type, radius_str, dist_str, desc_val in turnpoint_rows:
        if tp_type:
            lines.append(f"{wpt_id} \t{tp_type} \t{radius_str} \t{dist_str} \t{desc_val}")
        else:
            lines.append(f"{wpt_id} \t\t{radius_str} \t{dist_str} \t{desc_val}")
    if startgate:
        if len(startgate.split(":")) == 2:
            startgate += ":00"
        lines.append(f"Startgate: \t{startgate}")
    if deadline:
        if len(deadline.split(":")) == 2:
            deadline += ":00"
        lines.append(f"Deadline: \t{deadline}")

    return {
        "task_text": "\n".join(lines) + "\n",
        "pilot_map": pilot_map,
        "standings_lines": standings_lines,
        "startgate": startgate,
        "deadline": deadline,
        "turnpoint_count": len(turnpoint_rows),
    }


def extract_atdata_json(page_html, key):
    """Safely extract a JSON object/array assigned to window.ATDATA.<key>."""
    pattern = rf"window\.ATDATA\.{re.escape(key)}\s*=\s*"
    m = re.search(pattern, page_html)
    if not m:
        return None
    start_idx = m.end()
    while start_idx < len(page_html) and page_html[start_idx].isspace():
        start_idx += 1
    try:
        decoder = json.JSONDecoder()
        obj, _ = decoder.raw_decode(page_html, start_idx)
        return obj
    except Exception:
        return None


def discover_airtribune_event(url, comp_name_override=None):
    """
    Fetch Airtribune event page and discover competition metadata, waypoint file URL, and tasks.
    """
    base_url, slug, specific_task_id = parse_airtribune_url(url)
    results_page_url = f"{base_url}/{slug}/results"
    page_html = fetch_text(results_page_url)

    # 1. Extract competition title from ATDATA.meta
    comp_title = slug.upper()
    meta = extract_atdata_json(page_html, "meta")
    if isinstance(meta, dict):
        info = meta.get("info") or {}
        title = (info.get("title") or "").strip()
        desc = (info.get("description") or "").strip()
        if title:
            comp_title = title
            if "srs" in slug.lower() and "|" in desc:
                loc = desc.split("|", 1)[1].split(",")[0].strip()
                year_m = re.search(r"20\d{2}", title) or re.search(r"20\d{2}", desc)
                year_str = year_m.group(0) if year_m else ""
                if loc and loc.lower() not in title.lower():
                    comp_title = f"SRS {loc} {year_str}".strip()

    if comp_name_override and comp_name_override.strip():
        comp_title = comp_name_override.strip()

    # 2. Extract pilot list from ATDATA.pilots if available
    global_pilot_map = {}
    pilots_data = extract_atdata_json(page_html, "pilots")
    if isinstance(pilots_data, dict):
        for p in pilots_data.get("pilots") or []:
            p_name = (p.get("name") or "").strip()
            for key in ("contest_number", "srs_id", "id"):
                cid = p.get(key)
                if cid is not None and p_name:
                    cid_str = str(cid).strip()
                    clean_p = " ".join(w.capitalize() for w in strip_accents(p_name).split())
                    global_pilot_map[cid_str] = clean_p
                    global_pilot_map[cid_str.zfill(4)] = clean_p

    # 3. Find waypoint file URL (.cup preferred, then .FS.wpt, then .wpt)
    wpt_links = re.findall(
        r'href=["\']([^"\']+\.(?:cup|wpt))["\']', page_html, re.I
    )
    wpt_url = None
    for ext_pref in (".seeyou.cup", ".cup", ".fs.wpt", ".wpt"):
        for link in wpt_links:
            if link.lower().endswith(ext_pref):
                wpt_url = urllib.parse.urljoin(base_url, link)
                break
        if wpt_url:
            break

    # 4. Find tasks from ATDATA.blog and HTML .tasks-and-results blocks
    tasks = []
    seen_race_ids = set()

    blog_entries = extract_atdata_json(page_html, "blog")
    if isinstance(blog_entries, list):
        for entry in blog_entries:
            top_widget = entry.get("topWidget") or {}
            race_id = top_widget.get("raceId")
            tracks_inner = (entry.get("tracks") or {}).get("inner") or []
            results_inner = (entry.get("results_tables") or {}).get("inner") or []

            zip_url = None
            for t_item in tracks_inner:
                if (t_item.get("url") or "").lower().endswith(".zip"):
                    zip_url = urllib.parse.urljoin(base_url, t_item["url"])
                    break

            overall_url = None
            comp_overall_url = None
            for r_group in results_inner:
                g_title = (r_group.get("title") or "").lower()
                for link_item in r_group.get("inner") or []:
                    u = link_item.get("url")
                    if not u:
                        continue
                    full_u = urllib.parse.urljoin(base_url, u)
                    if "competition" in g_title or "overall" in g_title:
                        if not comp_overall_url:
                            comp_overall_url = full_u
                    else:
                        if not overall_url or "overall" in (link_item.get("title") or "").lower():
                            overall_url = full_u

            if not race_id and overall_url:
                m_rid = re.search(r"task(\d+)", overall_url)
                if m_rid:
                    race_id = int(m_rid.group(1))

            if not race_id or (not zip_url and not overall_url):
                continue

            race_id_str = str(race_id)
            if specific_task_id and race_id_str != str(specific_task_id):
                continue

            seen_race_ids.add(race_id_str)
            raw_title = html.unescape(entry.get("title") or "")
            m_tnum = re.search(r"Task\s*(\d+)", raw_title, re.I)
            task_num = int(m_tnum.group(1)) if m_tnum else len(tasks) + 1

            timeoffset_sec = entry.get("timeoffset")
            tz_offset = int(timeoffset_sec / 3600) if isinstance(timeoffset_sec, (int, float)) else None

            tasks.append({
                "race_id": race_id_str,
                "task_num": task_num,
                "date": entry.get("date") or "",
                "tz_offset": tz_offset,
                "zip_url": zip_url,
                "overall_url": overall_url or f"{base_url}/{slug}/results/task{race_id_str}/day/overall",
                "comp_overall_url": comp_overall_url,
            })

    # Fallback: parse .tasks-and-results HTML blocks if not found in ATDATA.blog
    for block_m in re.finditer(r'<div class="tasks-and-results">(.*?)</div>\s*<div class="clearfix"></div>\s*</div>', page_html, re.S | re.I):
        block = block_m.group(1)
        m_ov = re.search(r'href=["\']([^"\']*task(\d+)[^"\']*)["\']', block, re.I)
        if not m_ov:
            continue
        overall_url = urllib.parse.urljoin(base_url, m_ov.group(1))
        race_id_str = m_ov.group(2)
        if race_id_str in seen_race_ids:
            continue
        if specific_task_id and race_id_str != str(specific_task_id):
            continue
        seen_race_ids.add(race_id_str)

        m_tnum = re.search(r"<h2>\s*Task\s*(\d+)\s*</h2>", block, re.I)
        task_num = int(m_tnum.group(1)) if m_tnum else len(tasks) + 1
        m_zip = re.search(r'href=["\']([^"\']+\.zip)["\']', block, re.I)
        zip_url = urllib.parse.urljoin(base_url, m_zip.group(1)) if m_zip else None
        tasks.append({
            "race_id": race_id_str,
            "task_num": task_num,
            "date": "",
            "tz_offset": None,
            "zip_url": zip_url,
            "overall_url": overall_url,
            "comp_overall_url": None,
        })

    # Sort tasks chronologically by task_num
    tasks.sort(key=lambda t: t["task_num"])

    return {
        "base_url": base_url,
        "slug": slug,
        "comp_title": comp_title,
        "wpt_url": wpt_url,
        "tasks": tasks,
        "global_pilot_map": global_pilot_map,
    }


def load_manifest():
    for p in MANIFEST_PATHS:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
    return {"tasks": []}


def save_manifest(manifest_data):
    os.makedirs(TASKS_DIR, exist_ok=True)
    content = json.dumps(manifest_data, indent=2, ensure_ascii=False) + "\n"
    for p in MANIFEST_PATHS:
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)


def import_airtribune_competition(url, comp_name_override=None, force=False, progress_cb=None):
    """
    Download and import all tasks (or a specific task) from an Airtribune URL
    into Tasks/<comp_title>/ and update manifest.json.
    """
    def report(msg):
        print(f"[Airtribune Import] {msg}")
        if progress_cb:
            progress_cb(msg)

    report(f"Inspecting Airtribune page: {url}")
    event_info = discover_airtribune_event(url, comp_name_override=comp_name_override)
    comp_title = event_info["comp_title"]
    tasks = event_info["tasks"]

    if not tasks:
        raise RuntimeError(f"No published tasks with results/tracks found on {url}")

    comp_dir = os.path.join(TASKS_DIR, comp_title)
    os.makedirs(comp_dir, exist_ok=True)

    # 1. Download Waypoints (.cup / .wpt)
    wpt_rel_path = None
    if event_info["wpt_url"]:
        wpt_filename = os.path.basename(urllib.parse.urlparse(event_info["wpt_url"]).path)
        wpt_abs_path = os.path.join(comp_dir, wpt_filename)
        if not os.path.exists(wpt_abs_path) or force:
            report(f"Downloading waypoints: {wpt_filename}")
            wpt_bytes = fetch_bytes(event_info["wpt_url"])
            with open(wpt_abs_path, "wb") as f:
                f.write(wpt_bytes)
        wpt_rel_path = f"Tasks/{comp_title}/{wpt_filename}"

    manifest = load_manifest()
    imported_tasks = []
    latest_standings_lines = []

    for t in tasks:
        task_num = t["task_num"]
        task_id = f"{comp_title} T{task_num}"
        task_dir = os.path.join(comp_dir, task_id)
        os.makedirs(task_dir, exist_ok=True)

        report(f"Fetching task definition & standings for {task_id}...")
        overall_html = fetch_text(t["overall_url"])
        parsed_task = parse_task_overall_html(
            overall_html,
            fallback_task_name=f"Task {task_num}",
            fallback_date=t["date"],
        )

        # Save task definition file
        task_txt_filename = f"{task_id}.txt"
        task_txt_abs = os.path.join(task_dir, task_txt_filename)
        with open(task_txt_abs, "w", encoding="utf-8") as f:
            f.write(parsed_task["task_text"])
        task_rel_path = f"Tasks/{comp_title}/{task_id}/{task_txt_filename}"

        if parsed_task["standings_lines"]:
            latest_standings_lines = parsed_task["standings_lines"]

        # Merge pilot maps (task overall table + global contest pilot list)
        pilot_map = dict(event_info["global_pilot_map"])
        pilot_map.update(parsed_task["pilot_map"])

        # Download & extract IGC tracklogs zip
        igc_rel_files = []
        detected_tz = t["tz_offset"]

        if t["zip_url"]:
            report(f"Downloading IGC tracklogs archive for {task_id}...")
            zip_bytes = fetch_bytes(t["zip_url"], timeout=120)
            # Clear old .igc files in task_dir if re-importing
            for existing in os.listdir(task_dir):
                if existing.lower().endswith(".igc"):
                    os.remove(os.path.join(task_dir, existing))

            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                members = [m for m in zf.namelist() if m.lower().endswith(".igc") and not m.startswith("__MACOSX")]
                report(f"Extracting {len(members)} IGC tracks for {task_id}...")
                for member in members:
                    raw_bytes = zf.read(member)
                    orig_name = os.path.basename(member)
                    stem = os.path.splitext(orig_name)[0]

                    igc_text = raw_bytes.decode("utf-8", errors="replace")
                    hdr_pilot, hdr_tz = extract_igc_metadata(igc_text)
                    if detected_tz is None and hdr_tz is not None:
                        detected_tz = hdr_tz

                    # Determine pilot name if filename is purely numeric (like 0001.igc)
                    pilot_name = None
                    if re.match(r"^\d+$", stem):
                        pilot_name = pilot_map.get(stem) or pilot_map.get(stem.lstrip("0") or "0") or hdr_pilot
                        out_name = clean_pilot_filename(pilot_name, stem, orig_name)
                    else:
                        out_name = orig_name

                    out_abs = os.path.join(task_dir, out_name)
                    with open(out_abs, "wb") as out_f:
                        out_f.write(raw_bytes)
                    igc_rel_files.append(f"Tasks/{comp_title}/{task_id}/{out_name}")

        igc_rel_files.sort()

        # Save overall standings file if available
        standings_rel_path = None
        if latest_standings_lines:
            standings_filename = f"{comp_title} overall_standings.txt"
            standings_abs = os.path.join(comp_dir, standings_filename)
            with open(standings_abs, "w", encoding="utf-8") as sf:
                sf.write("\n".join(latest_standings_lines) + "\n")
            standings_rel_path = f"Tasks/{comp_title}/{standings_filename}"

        task_entry = {
            "id": task_id,
            "name": task_id,
            "comp": comp_title,
            "task_file": task_rel_path,
            "waypoint_file": wpt_rel_path,
            "timezone_offset": detected_tz if detected_tz is not None else -6,
            "igc_files": igc_rel_files,
        }
        if standings_rel_path:
            task_entry["overall_standings"] = standings_rel_path

        # Update or insert into manifest["tasks"]
        existing_idx = next((i for i, item in enumerate(manifest["tasks"]) if item.get("id") == task_id), -1)
        if existing_idx != -1:
            manifest["tasks"][existing_idx] = task_entry
        else:
            # Find last task of the same comp, or insert at top
            comp_indices = [i for i, item in enumerate(manifest["tasks"]) if item.get("comp") == comp_title]
            if comp_indices:
                manifest["tasks"].insert(comp_indices[-1] + 1, task_entry)
            else:
                manifest["tasks"].insert(0, task_entry)

        imported_tasks.append(task_entry)

    save_manifest(manifest)
    report(f"Successfully imported {len(imported_tasks)} task(s) for {comp_title}!")
    return {
        "comp": comp_title,
        "waypoint_file": wpt_rel_path,
        "imported_tasks": imported_tasks,
    }


def save_manual_task_to_disk(payload):
    """
    Save a manually uploaded task (waypoints text/filename, task text, IGC files)
    permanently to Tasks/<comp>/ and manifest.json.
    """
    comp_title = (payload.get("comp") or "Custom Comp").strip()
    task_name = (payload.get("taskName") or f"{comp_title} T1").strip()
    task_id = task_name
    tz_offset = payload.get("timezoneOffset", "auto")
    if tz_offset != "auto":
        try:
            tz_offset = float(tz_offset)
            if tz_offset.is_integer():
                tz_offset = int(tz_offset)
        except Exception:
            tz_offset = "auto"

    comp_dir = os.path.join(TASKS_DIR, comp_title)
    task_dir = os.path.join(comp_dir, task_id)
    os.makedirs(task_dir, exist_ok=True)

    wpt_rel_path = None
    wpt_name = payload.get("waypointFilename")
    wpt_content = payload.get("waypointContent")
    if wpt_name and wpt_content:
        wpt_abs = os.path.join(comp_dir, os.path.basename(wpt_name))
        with open(wpt_abs, "w", encoding="utf-8") as f:
            f.write(wpt_content)
        wpt_rel_path = f"Tasks/{comp_title}/{os.path.basename(wpt_name)}"
    else:
        # Check if comp_dir already has a .cup or .wpt file
        for existing in os.listdir(comp_dir):
            if existing.lower().endswith((".cup", ".wpt")):
                wpt_rel_path = f"Tasks/{comp_title}/{existing}"
                break

    task_text = payload.get("taskText") or ""
    task_txt_filename = f"{task_id}.txt"
    task_txt_abs = os.path.join(task_dir, task_txt_filename)
    with open(task_txt_abs, "w", encoding="utf-8") as f:
        f.write(task_text)
    task_rel_path = f"Tasks/{comp_title}/{task_id}/{task_txt_filename}"

    igc_rel_files = []
    for igc_item in payload.get("igcFiles") or []:
        fname = os.path.basename(igc_item.get("name") or "track.igc")
        content = igc_item.get("content") or ""
        if not content:
            continue
        stem = os.path.splitext(fname)[0]
        hdr_pilot, _ = extract_igc_metadata(content)
        if re.match(r"^\d+$", stem) and hdr_pilot:
            fname = clean_pilot_filename(hdr_pilot, stem, fname)
        out_abs = os.path.join(task_dir, fname)
        with open(out_abs, "w", encoding="utf-8") as f:
            f.write(content)
        igc_rel_files.append(f"Tasks/{comp_title}/{task_id}/{fname}")

    igc_rel_files.sort()

    manifest = load_manifest()
    task_entry = {
        "id": task_id,
        "name": task_name,
        "comp": comp_title,
        "task_file": task_rel_path,
        "waypoint_file": wpt_rel_path,
        "timezone_offset": tz_offset,
        "igc_files": igc_rel_files,
    }

    existing_idx = next((i for i, item in enumerate(manifest["tasks"]) if item.get("id") == task_id), -1)
    if existing_idx != -1:
        manifest["tasks"][existing_idx] = task_entry
    else:
        comp_indices = [i for i, item in enumerate(manifest["tasks"]) if item.get("comp") == comp_title]
        if comp_indices:
            manifest["tasks"].insert(comp_indices[-1] + 1, task_entry)
        else:
            manifest["tasks"].insert(0, task_entry)

    save_manifest(manifest)
    return {"comp": comp_title, "imported_tasks": [task_entry]}


class RaceAnalyzerRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        # Allow CORS so the API works even if the frontend is opened via VS Code Live Server or file://
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/status"):
            self._send_json(200, {"ok": True, "server": "PG Race Analyzer Local Server"})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/import-airtribune":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
                url = body.get("url", "").strip()
                comp_name = body.get("compName", "").strip() or None
                force = bool(body.get("force", False))
                if not url:
                    self._send_json(400, {"ok": False, "error": "Missing Airtribune URL"})
                    return
                result = import_airtribune_competition(url, comp_name_override=comp_name, force=force)
                self._send_json(200, {"ok": True, **result})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if self.path == "/api/save-manual-task":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
                result = save_manual_task_to_disk(body)
                self._send_json(200, {"ok": True, **result})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        self._send_json(404, {"ok": False, "error": "Not found"})

    def _send_json(self, status_code, data):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description="PG Race Analyzer Server & Airtribune Importer")
    parser.add_argument("--import", dest="import_url", help="Airtribune competition or task URL to import")
    parser.add_argument("--comp", dest="comp_name", help="Optional competition name override (e.g. 'SRS Tapalpa 2026')")
    parser.add_argument("--force", action="store_true", help="Force re-download of existing files")
    parser.add_argument("--port", type=int, default=8000, help="Port for local HTTP server (default: 8000)")
    args = parser.parse_args()

    if args.import_url:
        res = import_airtribune_competition(args.import_url, comp_name_override=args.comp_name, force=args.force)
        print(json.dumps(res, indent=2))
        return

    server = ThreadingHTTPServer(("0.0.0.0", args.port), RaceAnalyzerRequestHandler)
    print(f"PG Race Analyzer server running at http://localhost:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")


if __name__ == "__main__":
    main()
