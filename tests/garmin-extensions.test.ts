import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import { repair } from "../src/repair/repair";
import { FIT_EPOCH } from "../src/protocol/time";
import { wrapBody } from "../src/protocol/writer";
import { data, definition, file, join, type Field } from "./fixtures";
import { Profile } from "@garmin/fitsdk";
import { garminExtensions } from "../src/metadata/garmin-extensions";

const status: Field[] = [
  [253, 6, 1100000000],
  [0, 0, 1],
  [1, 6, 1099900000],
  [2, 6, 1100100000],
  [3, 6, 42],
];
const iso = (time: number) => new Date(FIT_EPOCH + time * 1000).toISOString();

test("every supplemental field is visible with its documented layout, including all 47 private message types", async () => {
  const privateIds = Object.keys(garminExtensions)
    .map(Number)
    .filter((id) => !Profile.messages[id])
    .sort((a, b) => a - b);
  assert.deepEqual(
    privateIds,
    [
      14, 16, 17, 22, 29, 70, 71, 79, 89, 104, 113, 114, 140, 141, 143, 144,
      147, 152, 170, 173, 189, 190, 191, 192, 193, 194, 222, 243, 273, 309, 310,
      311, 321, 326, 336, 337, 338, 356, 358, 369, 378, 379, 382, 394, 402, 403,
      428,
    ],
  );
  let count = 0;
  for (const [id, message] of Object.entries(garminExtensions)) {
    const fields: Field[] = Object.entries(message!.fields).map(
      ([key, field]) => [
        Number(key),
        field!.baseType,
        field!.baseType === 7 ? "example" : field!.array ? [1, 2] : 1,
      ],
    );
    for (const little of [true, false]) {
      // A different Garmin model proves this is not relying on our one-watch overlay.
      const document = await FitDocument.open(
        file([{ message: Number(id), fields, little }], true, 999),
        "catalog.fit",
      );
      const visible = document.getFields(Number(id), false);
      for (const [key] of fields)
        assert.ok(
          visible.some((f) => f.id === key && !f.unknown),
          `${id}:${key}`,
        );
      assert.ok(document.messageInfo.find((m) => m.id === Number(id))?.known);
    }
    count += fields.length;
  }
  assert.equal(count, 473);
});

test("supplemental arrays, coordinates, offsets, strings and session metrics preserve precision and missing slots", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 2,
          fields: [
            [8, 4, [60, 65535, 120]],
            [28, 0, [0, 255, 1]],
          ],
        },
        { message: 2, fields: [[8, 4, 90]] },
        { message: 3, fields: [[24, 2, 96]] },
        {
          message: 18,
          fields: [
            [79, 4, 185],
            [152, 6, 12345],
            [211, 6, 2345],
            [215, 2, 80],
            [216, 2, 45],
          ],
        },
        {
          message: 19,
          fields: [
            [27, 5, 1073741824],
            [28, 5, -1073741824],
          ],
          little: false,
        },
        {
          message: 29,
          fields: [
            [0, 7, "Trail start"],
            [1, 5, 536870912],
            [4, 4, 3000],
          ],
        },
        {
          message: 79,
          fields: [
            [0, 4, 16384],
            [19, 5, 1048576],
          ],
        },
        {
          message: 20,
          fields: [
            [136, 2, 78],
            [143, 2, 63],
          ],
        },
      ],
      true,
      999,
    ),
    "values.fit",
  );
  const cells = (id: number, row = 0) =>
    document.cells(document.recordIds(id)[row]);
  assert.deepEqual(cells(2)["8"].value, [60, null, 120]);
  assert.deepEqual(cells(2)["28"].value, ["Off", null, "On"]);
  assert.deepEqual(cells(2, 1)["8"].raw, [90]);
  assert.equal(cells(3)["24"].value, 1996);
  assert.equal(cells(18)["79"].value, 18.5);
  assert.equal(cells(18)["152"].value, 123.45);
  assert.equal(cells(18)["211"].value, 2.345);
  assert.equal(cells(18)["215"].value, 80);
  assert.equal(cells(18)["216"].value, 45);
  assert.equal(cells(19)["27"].value, 90);
  assert.equal(cells(19)["28"].value, -90);
  assert.equal(cells(29)["0"].value, "Trail start");
  assert.equal(cells(29)["1"].value, 45);
  assert.equal(cells(29)["4"].value, 100);
  assert.equal(cells(79)["0"].value, 56);
  assert.equal(cells(79)["19"].value, 56);
  assert.equal(cells(20)["136"].value, 78);
  assert.equal(cells(20)["143"].value, 63);
});

test("conditional metadata uses raw controllers and does not leak across records sharing a definition", async () => {
  const gps: Field[] = [
    [0, 6, 49],
    [1, 6, 0x41],
  ];
  const bytes = join([
    definition(326, gps),
    data(gps),
    data([
      [0, 6, 11],
      [1, 6, 0x41],
    ]),
    data([
      [0, 6, 49],
      [1, 6, 0x4001],
    ]),
    definition(0, [
      [1, 4, 1],
      [2, 4, 999],
    ]),
    data([
      [1, 4, 1],
      [2, 4, 999],
    ]),
  ]);
  const document = await FitDocument.open(wrapBody(bytes), "variants.fit");
  assert.equal(document.cells(0)["1"].value, "GPS L1 | Galileo E1");
  assert.equal(document.cells(1)["1"].value, 0x41);
  assert.equal(document.cells(2)["1"].value, "GPS L1 | 0x4000");
  const alerts = await FitDocument.open(
    file(
      [
        {
          message: 16,
          fields: [
            [1, 0, 0],
            [2, 6, 65000],
          ],
        },
        {
          message: 16,
          fields: [
            [1, 0, 1],
            [2, 6, 12500],
          ],
        },
        {
          message: 326,
          fields: [
            [0, 2, 49],
            [1, 6, 65],
          ],
        },
      ],
      true,
      999,
    ),
    "controllers.fit",
  );
  assert.equal(alerts.cells(alerts.recordIds(16)[0])["2"].value, 65);
  assert.equal(alerts.cells(alerts.recordIds(16)[1])["2"].value, 125);
  assert.equal(alerts.cells(alerts.recordIds(326)[0])["1"].value, 65);
});

test("unidentified messages and placeholder fields remain numeric in Developer mode", async () => {
  const ids = [233, 288, 325, 327, 432, 499, 517, 534];
  const document = await FitDocument.open(
    file([
      ...ids.map((message) => ({ message, fields: [[0, 6, 123]] as Field[] })),
      { message: 70, fields: [[29, 7, "unidentified"]] },
      {
        message: 170,
        fields: [
          [100, 2, 1],
          [101, 2, 2],
        ],
      },
    ]),
    "unknown.fit",
  );
  for (const id of ids) {
    assert.equal(document.messageInfo.find((m) => m.id === id)?.known, false);
    assert.equal(document.getFields(id, false).length, 0);
    assert.equal(document.getFields(id, true)[0].name, "Field 0");
  }
  assert.equal(document.getFields(70, false).length, 0);
  assert.equal(document.getFields(170, false).length, 0);
});

test("Garmin private messages expose supported fields in tables and combined entries", async () => {
  const bytes = file([
    { message: 141, fields: status },
    { message: 394, fields: status, little: false },
    {
      message: 22,
      fields: [
        [0, 2, 2],
        [4, 2, 3],
        [5, 0, 3],
      ],
    },
    {
      message: 22,
      fields: [
        [0, 2, 4],
        [4, 2, 5],
        [5, 0, 3],
      ],
    },
    {
      message: 79,
      fields: [
        [253, 6, 1100000000],
        [1, 2, 30],
        [2, 2, 180],
        [3, 4, 725],
        [4, 0, 1],
        [6, 2, 190],
        [8, 4, 90],
        [11, 4, 170],
        [12, 4, 250],
        [13, 4, 123],
        [15, 2, 80],
        [16, 6, 1100000000],
        [47, 4, 321],
      ],
    },
    {
      message: 104,
      fields: [
        [0, 4, 4009],
        [2, 2, 65],
        [3, 1, -2],
      ],
    },
    {
      message: 326,
      fields: [
        [253, 6, 1100000000],
        [0, 6, 49],
        [1, 6, 1],
      ],
    },
  ]);
  const original = bytes.slice();
  const document = await FitDocument.open(bytes, "private.fit");
  const names = new Map(
    document.messageInfo.map((message) => [message.id, message]),
  );
  for (const [id, name] of [
    [22, "Device Used"],
    [79, "User Metrics"],
    [104, "Device Status"],
    [141, "EPO Status"],
    [326, "GPS Event"],
    [394, "CPE Status"],
  ] as const) {
    assert.equal(names.get(id)?.name, name);
    assert.equal(names.get(id)?.known, true);
  }
  const combined = await document.singletons(false);
  for (const id of [79, 104, 141, 326, 394])
    assert.ok(combined.entries.some((entry) => entry.message.id === id));
  assert.ok(!combined.entries.some((entry) => entry.message.id === 22));
  const epo = await document.table({
    message: 141,
    developer: false,
    page: 0,
    size: 20,
  });
  assert.deepEqual(
    epo.fields.map((field) => field.name),
    ["Timestamp", "Status", "Start Time", "End Time"],
  );
  assert.equal(epo.rows[0].cells["0"].value, "Current");
  assert.equal(epo.rows[0].cells["0"].raw, 1);
  assert.equal(epo.rows[0].cells["1"].value, iso(1099900000));
  assert.equal(
    document.cells(document.recordIds(394)[0])["2"].value,
    iso(1100100000),
  );
  assert.ok(
    document
      .getFields(141, true)
      .some((field) => field.id === 3 && field.unknown),
  );
  const metrics = document.cells(document.recordIds(79)[0]);
  for (const [key, value] of Object.entries({
    "1": 30,
    "2": 1.8,
    "3": 72.5,
    "4": "Male",
    "6": 190,
    "8": 90,
    "11": 170,
    "12": 250,
    "13": 12.3,
    "15": 80,
  }))
    assert.equal(metrics[key].value, value);
  assert.equal(metrics["3"].raw, 725);
  assert.equal(metrics["16"].value, iso(1100000000));
  assert.ok(!document.getFields(79, false).some((field) => field.id === 47));
  assert.equal(document.cells(document.recordIds(22)[0])["0"].value, 2);
  const battery = document.cells(document.recordIds(104)[0]);
  assert.equal(battery["0"].value, 4.009);
  assert.equal(battery["3"].value, -2);
  assert.equal(
    document.cells(document.recordIds(326)[0])["0"].value,
    "Mode Change",
  );
  const csv = await (
    await exportDocument(document, { format: "csv", message: 141 })
  ).blob.text();
  assert.ok(csv.includes("Status,Start Time,End Time"));
  assert.ok(csv.includes(`Current,${iso(1099900000)},${iso(1100100000)}`));
  assert.deepEqual(bytes, original);
  assert.deepEqual((await repair(document)).bytes, original);
});

test("supplemental metadata requires matching scalar wire types and preserves unlisted status codes", async () => {
  const document = await FitDocument.open(
    file([
      {
        message: 141,
        fields: [
          [0, 0, 9],
          [1, 6, 0xffffffff],
        ],
      },
      { message: 141, fields: [[0, 0, 255]] },
      {
        message: 394,
        fields: [
          [0, 2, 1],
          [1, 6, [100, 200]],
        ],
      },
      {
        message: 79,
        fields: [
          [3, 8, 725],
          [2, 2, [180, 181]],
        ],
      },
    ]),
    "layouts.fit",
  );
  assert.equal(document.cells(document.recordIds(141)[0])["0"].value, 9);
  assert.equal(document.cells(document.recordIds(141)[0])["1"].value, null);
  assert.equal(document.cells(document.recordIds(141)[1])["0"].value, null);
  assert.equal(document.getFields(394, false).length, 0);
  assert.equal(document.getFields(79, false).length, 0);
  assert.deepEqual(
    document.cells(document.recordIds(394)[0])["1"].value,
    [100, 200],
  );
  assert.equal(document.cells(document.recordIds(79)[0])["3"].value, 725);
});

test("Garmin identity can arrive late but must not leak into other subfiles or ZIP entries", async () => {
  const identity: Field[] = [
    [0, 0, 4],
    [1, 4, 1],
    [2, 4, 999],
  ];
  const late = wrapBody(
    join([
      definition(141, status),
      data(status),
      definition(0, identity),
      data(identity),
    ]),
  );
  const other = file(
    [
      {
        message: 0,
        fields: [
          [0, 0, 4],
          [1, 4, 32],
          [2, 4, 4586],
        ],
      },
      { message: 141, fields: status },
    ],
    false,
  );
  const anonymous = file([{ message: 141, fields: status }], false);
  const standalone = await FitDocument.open(other, "other.fit");
  assert.equal(
    standalone.messageInfo.find((message) => message.id === 141)?.known,
    false,
  );
  for (const document of [
    await FitDocument.open(join([late, other, anonymous]), "joined.fit"),
    await FitDocument.openSources(
      [
        { filename: "late.fit", bytes: late },
        { filename: "other.fit", bytes: other },
        { filename: "anonymous.fit", bytes: anonymous },
      ],
      "sources.zip",
    ),
  ]) {
    const [garmin, unrelated, unidentified] = document.recordIds(141);
    assert.equal(document.cells(garmin)["0"].value, "Current");
    for (const id of [unrelated, unidentified]) {
      assert.equal(document.cells(id)["0"].value, 1);
      assert.equal(document.cells(id)["1"].value, 1099900000);
    }
  }
});
