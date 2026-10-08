"""Import protocol facts from the public supplemental FIT workbook.

Usage: python3 scripts/import-garmin-reference.py reference.xlsx
The workbook is a maintenance input only; builds use the checked-in JSON.
"""

import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

SOURCE = "https://docs.google.com/spreadsheets/d/1x34eRAZ45nbi3U3GyANotgmoQfj0fR49wBxmL-oLogc/"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def number(value):
    return int(value, 16) if value.lower().startswith("0x") else float(value)


def read_rows(archive, sheet, strings):
    tree = ET.fromstring(archive.read(f"xl/worksheets/sheet{sheet}.xml"))
    for row in tree.findall(".//m:row", NS)[1:]:
        cells = {}
        for cell in row:
            value = cell.findtext("m:v", "", NS)
            if cell.get("t") == "s":
                value = strings[int(value)]
            cells["".join(c for c in cell.get("r") if c.isalpha())] = value
        yield cells


def main():
    path = Path(sys.argv[1])
    types, messages = {}, {}
    with zipfile.ZipFile(path) as archive:
        strings = ["".join(n.itertext()) for n in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        current = None
        for row in read_rows(archive, 1, strings):
            if row.get("A"):
                current = {"base": row["B"], "values": {}}
                types[row["A"]] = current
            if current is not None and row.get("C") and row.get("D") and "?" not in row["C"]:
                current["values"][str(int(number(row["D"])))] = row["C"]
        parent = None
        for row in read_rows(archive, 2, strings):
            if row.get("A"):
                parent = None
                current = None
                if "?" not in row["A"]:
                    current = {"fields": {}}
                    if row.get("Q"):
                        current["id"] = int(number(row["Q"]))
                    messages[row["A"]] = current
            if current is None or not row.get("C") or "?" in row["C"] or row["C"] == "some_label":
                continue
            info = {"name": row["C"], "type": row["D"]}
            for column, key in [("G", "scale"), ("H", "offset")]:
                if row.get(column) and "," not in row[column]:
                    info[key] = number(row[column])
            if row.get("I") and "," not in row["I"]:
                info["units"] = row["I"]
            if row.get("E"):
                info["array"] = True
            if row.get("B"):
                field_id = int(number(row["B"]))
                parent = None
                # Components use virtual IDs; they are not independent wire fields.
                if field_id > 255 or row.get("D") == "bits" or row["C"] == "screen_id":
                    continue
                parent = info
                current["fields"][str(field_id)] = info
            elif parent is not None and row.get("L") and row.get("M"):
                info["when"] = [{"field": f, "value": v} for f, v in zip(row["L"].split(","), row["M"].split(","), strict=True)]
                parent.setdefault("variants", []).append(info)
    output = {
        "source": SOURCE,
        "referenceSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "types": types,
        "messages": messages,
    }
    destination = Path(__file__).resolve().parents[1] / "src/metadata/garmin-reference.json"
    destination.write_text(json.dumps(output, indent=2, ensure_ascii=True) + "\n")
    print(f"Imported {len(messages)} message definitions and {sum(len(m['fields']) for m in messages.values())} field definitions")


if __name__ == "__main__":
    main()
