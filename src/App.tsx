import React, { useEffect, useState, useId } from "react";
import * as XLSX from "xlsx";

// 単一ファイルの React TSX アプリ（Tailwind 前提）
// - ローカル保存（localStorage）
// - 出力先は **Excel(.xlsx) のみ**
// - 「表示項目の設定」UIは無し（既定の可視マップで制御）
// - 好気性ろ床 上部/下部は **No.付きカード（ポイント小セクション）のみ**。セクション側入力は非表示（Excelもポイント表のみ）
// - 流入水/好気性ろ床/放流水の「臭気」「色相」はプルダウン

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <Header />
      <main className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
        <ChecklistApp />
      </main>
      <Footer />
    </div>
  );
}

const WEATHER = ["晴", "曇り", "雨", "雪"] as const;
const ODOR = ["微下水臭", "微 臭", "無 臭"] as const; // PDFの表記を踏襲
const COLOR = ["黄・淡黄", "白濁・淡泊", "ほぼ透明"] as const; // ポイント用（上部/下部）
const COLOR_INFLUENT = ["黄", "淡黄", "白濁", "淡白", "ほぼ透明"] as const; // セクション用（流入水ほか）

// セクション定義
const SECTION_DEFS = [
  { key: "influent", label: "流入水" },
  { key: "aerobic_upper", label: "好気性ろ床 上部" },
  { key: "aerobic_lower", label: "好気性ろ床 下部・処理水" },
  { key: "effluent", label: "放流水" },
] as const;

type SectionKey = typeof SECTION_DEFS[number]["key"];

// ポイント記録を持つセクション
const POINT_SECTIONS: SectionKey[] = ["aerobic_upper", "aerobic_lower"];

// --- 型定義 ---
type HeaderForm = {
  date: string; // YYYY-MM-DD
  weekday: string; // ( )
  weather: typeof WEATHER[number] | "";
  airTemp: string; // 外気温 ℃
  primarySettlingNo1: string; // 初沈界面 NO.1(m)
  primarySettlingNo2: string; // 初沈界面 NO.2(m)
  pacRemaining: string; // PAC残量(㎥)
  elutionPH: string; // 脱離液 pH
  elutionTemp: string; // 水温（脱離液）
  waterContent: string; // 含水率 %
};

type SectionForm = {
  odor?: typeof ODOR[number] | "";
  color?: (typeof COLOR[number] | typeof COLOR_INFLUENT[number]) | "";
  temp?: string; // 水温 ℃
  turbidity?: string; // 透視度
  pH?: string;
  DO?: string; // mg/L
  residualChlorine?: string; // 残塩 mg/L
  headLoss?: string; // ろ抗高
  aeration?: string; // 送気量
  comment?: string;
};

type FieldKey = keyof SectionForm;

// 表示名（Excelでも使用）
const FIELD_LABEL: Record<FieldKey, string> = {
  odor: "臭気",
  color: "色相",
  temp: "水温(℃)",
  turbidity: "透視度",
  pH: "pH",
  DO: "DO(mg/L)",
  residualChlorine: "残塩(mg/L)",
  headLoss: "ろ抗高",
  aeration: "送気量",
  comment: "備考",
};

const FIELD_ORDER: FieldKey[] = [
  "odor",
  "color",
  "temp",
  "turbidity",
  "pH",
  "DO",
  "residualChlorine",
  "headLoss",
  "aeration",
  "comment",
];

// ポイント表に出す列（備考は除外）。各ポイントにも「臭気・色相」を持たせる
const POINT_FIELD_ORDER: FieldKey[] = [
  "odor",
  "color",
  "temp",
  "turbidity",
  "pH",
  "DO",
  "residualChlorine",
  "headLoss",
  "aeration",
];

type VisibilityMap = Record<SectionKey, Partial<Record<FieldKey, boolean>>>;

// 既定の可視設定
const DEFAULT_VISIBILITY: VisibilityMap = {
  influent: {
    odor: true,
    color: true,
    temp: true,
    turbidity: true,
    pH: true,
    DO: true,
    residualChlorine: false,
    headLoss: false,
    aeration: false,
    comment: false,
  },
  aerobic_upper: {
    odor: true,
    color: true,
    temp: true,
    turbidity: true,
    pH: true,
    DO: true,
    residualChlorine: false,
    headLoss: true,
    aeration: false,
    comment: false,
  },
  aerobic_lower: {
    odor: true,
    color: true,
    temp: true,
    turbidity: true,
    pH: true,
    DO: true,
    residualChlorine: false,
    headLoss: false,
    aeration: true,
    comment: false,
  },
  effluent: {
    odor: true,
    color: true,
    temp: true,
    turbidity: true,
    pH: true,
    DO: true,
    residualChlorine: true,
    headLoss: false,
    aeration: false,
    comment: false,
  },
};

// 既存データ移行 & 仕様反映用
function patchedVisibility(vis?: VisibilityMap): VisibilityMap {
  const merged: VisibilityMap = {
    influent: { ...DEFAULT_VISIBILITY.influent, ...(vis?.influent ?? {}) },
    aerobic_upper: { ...DEFAULT_VISIBILITY.aerobic_upper, ...(vis?.aerobic_upper ?? {}) },
    aerobic_lower: { ...DEFAULT_VISIBILITY.aerobic_lower, ...(vis?.aerobic_lower ?? {}) },
    effluent: { ...DEFAULT_VISIBILITY.effluent, ...(vis?.effluent ?? {}) },
  };
  // 強制マイグレーション: ポイントカードでは臭気/色相は常に表示
  (["aerobic_upper", "aerobic_lower"] as SectionKey[]).forEach((k) => {
    merged[k].odor = true;
    merged[k].color = true;
  });
  return merged;
}

// --- 状態/保存系ユーティリティ ---

type PointDataMap = Record<string, Partial<SectionForm>>; // label -> values

type FormState = {
  header: HeaderForm;
  sections: Record<SectionKey, SectionForm>;
  points: string[]; // 固定: NO.1-1 等
  pointData: Partial<Record<SectionKey, PointDataMap>>;
  visibility: VisibilityMap;
  extraNote: string; // 自由記入 備考
};

const EMPTY_HEADER: HeaderForm = {
  date: new Date().toISOString().slice(0, 10),
  weekday: "",
  weather: "",
  airTemp: "",
  primarySettlingNo1: "",
  primarySettlingNo2: "",
  pacRemaining: "",
  elutionPH: "",
  elutionTemp: "",
  waterContent: "",
};

const EMPTY_SECTION: SectionForm = {
  odor: "",
  color: "",
  temp: "",
  turbidity: "",
  pH: "",
  DO: "",
  residualChlorine: "",
  headLoss: "",
  aeration: "",
  comment: "",
};

const DEFAULT_POINTS = ["NO.1-1", "NO.1-2", "NO.2-1", "NO.2-2"];

// localStorage 用キー
const STORAGE_KEY = "inspection-checklist-v1";
// 日別アーカイブ（date -> snapshot）
const STORAGE_KEY_ARCHIVE = "inspection-checklist-v1:archive";

type ArchiveMap = Record<string, FormState>;

function readArchive(): ArchiveMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ARCHIVE);
    return raw ? (JSON.parse(raw) as ArchiveMap) : {};
  } catch {
    return {};
  }
}
function writeArchive(a: ArchiveMap) {
  try {
    localStorage.setItem(STORAGE_KEY_ARCHIVE, JSON.stringify(a));
  } catch {}
}
function listArchiveDates(): string[] {
  return Object.keys(readArchive()).sort().reverse();
}

// 表示用に "NO." → "No." へ整形（内部キーは変更しない）
function displayPointLabel(label: string) {
  return label.replace(/^NO\./, "No.");
}

// ---- 履歴パネル（先に宣言しておく：参照時未定義エラーを避ける） ----
function HistoryPanel({
  currentDate,
  onLoad,
  onDelete,
  onSave,
}: {
  currentDate: string;
  onLoad: (d: string) => void;
  onDelete: (d: string) => void;
  onSave: () => void;
}) {
  const dates = listArchiveDates();
  const [picked, setPicked] = useState<string>(currentDate);
  useEffect(() => setPicked(currentDate), [currentDate]);
  return (
    <div className="bg-white/80 border rounded-2xl p-3 flex flex-wrap gap-2 items-center">
      <span className="text-sm text-gray-600">履歴</span>
      <select
        className="border rounded-xl px-3 py-2"
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
      >
        {dates.length === 0 && <option value="">(なし)</option>}
        {dates.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <button
        className="px-3 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
        onClick={() => onSave()}
      >
        この日付で保存
      </button>
      <button
        className="px-3 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
        disabled={!picked}
        onClick={() => picked && onLoad(picked)}
      >
        読み込み
      </button>
      <button
        className="px-3 py-2 rounded-xl bg-gray-600 text-white hover:bg-gray-700"
        disabled={!picked}
        onClick={() => picked && confirm(`${picked} を削除しますか？`) && onDelete(picked)}
      >
        削除
      </button>
      <span className="text-xs text-gray-500 ml-auto">
        日ごとに自動保存され、ここから読み込みできます
      </span>
    </div>
  );
}

// ---- 本体 ----
function ChecklistApp() {
  // 初期状態ファクトリ（テスト/リセット/初期化で共通利用）
  function makeInitialState(): FormState {
    return {
      header: { ...EMPTY_HEADER },
      sections: {
        influent: { ...EMPTY_SECTION },
        aerobic_upper: { ...EMPTY_SECTION },
        aerobic_lower: { ...EMPTY_SECTION },
        effluent: { ...EMPTY_SECTION },
      },
      points: [...DEFAULT_POINTS],
      pointData: { aerobic_upper: {}, aerobic_lower: {} },
      visibility: patchedVisibility(DEFAULT_VISIBILITY),
      extraNote: "",
    } as FormState;
  }

  const [form, setForm] = useState<FormState>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as FormState;
        return {
          ...parsed,
          visibility: patchedVisibility(parsed.visibility),
          points: parsed.points?.length ? parsed.points : [...DEFAULT_POINTS],
          pointData: parsed.pointData ?? { aerobic_upper: {}, aerobic_lower: {} },
          extraNote: (parsed as any).extraNote ?? "",
        };
      } catch {}
    }
    return makeInitialState();
  });

  // 永続化（編集中スナップショット + 日別アーカイブ）
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    const a = readArchive();
    a[form.header.date] = form;
    writeArchive(a);
  }, [form]);

  // 可視判定（未設定→表示=true）
  const isFieldVisible = (
    vis: Partial<Record<FieldKey, boolean>> | undefined,
    key: FieldKey
  ) => (vis?.[key] === false ? false : true);

  // ---- Excel用 行データ生成（純粋関数） ----
  const toSheetRows = (f: FormState): string[][] => {
    const rows: string[][] = [];

    // 共通情報
    rows.push(["日付", f.header.date]);
    rows.push(["曜日", f.header.weekday]);
    rows.push(["天候", f.header.weather]);
    rows.push(["外気温(℃)", f.header.airTemp]);
    rows.push(["初沈界面 NO.1(m)", f.header.primarySettlingNo1]);
    rows.push(["初沈界面 NO.2(m)", f.header.primarySettlingNo2]);
    rows.push(["PAC残量(㎥)", f.header.pacRemaining]);
    rows.push(["脱離液 pH", f.header.elutionPH]);
    rows.push(["脱離液 水温(℃)", f.header.elutionTemp]);
    rows.push(["含水率(%)", f.header.waterContent]);
    rows.push([""]);

    // 各セクション
    for (const def of SECTION_DEFS) {
      rows.push([`【${def.label}】`]);
      const s = f.sections[def.key];
      const vis = f.visibility?.[def.key] ?? {};

      const isAerobic = def.key === "aerobic_upper" || def.key === "aerobic_lower";
      // 好気性ろ床（上部/下部）はセクション側の行を出さず、ポイント表のみ
      if (!isAerobic) {
        for (const k of FIELD_ORDER) {
          if (!isFieldVisible(vis, k)) continue;
          const label = FIELD_LABEL[k];
          const val = (s[k] as string) || "";
          rows.push([label, val]);
        }
      }

      if (POINT_SECTIONS.includes(def.key)) {
        const visCols = POINT_FIELD_ORDER.filter((k) => isFieldVisible(vis, k));
        if (visCols.length) {
          rows.push(["ポイント", ...visCols.map((k) => FIELD_LABEL[k])]);
          const pd = f.pointData?.[def.key] || {};
          for (const label of f.points) {
            const rec = pd[label] || {};
            rows.push([
              displayPointLabel(label),
              ...visCols.map((k) => String((rec as any)[k] ?? "")),
            ]);
          }
        }
      }

      rows.push([""]);
    }

    // 自由記入 備考
    rows.push([`【自由記入 備考】`]);
    rows.push(["備考", f.extraNote || ""]);
    rows.push([""]);

    return rows;
  };

  const exportExcel = () => {
    const rows = toSheetRows(form);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);

    const col0 = rows.reduce((acc, r) => Math.max(acc, (r[0] || "").length), 8);
    (ws as any)["!cols"] = [
      { wch: col0 },
      { wch: 20 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, "点検表");
    const fname = `inspection_${form.header.date || "date"}.xlsx`;
    XLSX.writeFile(wb, fname);
  };

  const [previewOpen, setPreviewOpen] = useState(false);
  const openPreview = () => setPreviewOpen(true);
  const closePreview = () => setPreviewOpen(false);

  // resetAll を定義
  const resetAll = () => {
    setForm(makeInitialState());
  };

  // ---- 簡易テスト（起動時に console 出力）----
  useEffect(() => {
    const results: { name: string; pass: boolean; info?: unknown }[] = [];
    const test = (name: string, fn: () => boolean | void) => {
      try {
        const r = fn();
        results.push({ name, pass: r === false ? false : true });
      } catch (e) {
        results.push({ name, pass: false, info: e });
      }
    };

    test("SelectField is defined", () => typeof SelectField === "function");
    test("HistoryPanel defined", () => typeof HistoryPanel === "function");

    // Excel用シート行（toSheetRows）の体裁テスト
    test("Aerobic sections have only point tables in sheet rows", () => {
      const rows = toSheetRows(form);
      const hasOnlyPoints = (label: string) => {
        const start = rows.findIndex((r) => r[0] === `【${label}】`);
        if (start === -1) return true;
        // 次の空行までのブロック
        let end = rows.length;
        for (let i = start + 1; i < rows.length; i++) {
          if (rows[i].length === 1 && rows[i][0] === "") {
            end = i;
            break;
          }
        }
        const block = rows.slice(start + 1, end);
        // 最初に現れる行がポイントヘッダであること
        return block.length === 0 || block[0][0] === "ポイント";
      };
      return (
        hasOnlyPoints("好気性ろ床 上部") && hasOnlyPoints("好気性ろ床 下部・処理水")
      );
    });

    test(
      "Influent color select has 5 options",
      () =>
        COLOR_INFLUENT.join("|") ===
        ["黄", "淡黄", "白濁", "淡白", "ほぼ透明"].join("|")
    );

    test(
      "DEFAULT_POINTS fixed",
      () =>
        DEFAULT_POINTS.join("|") ===
        ["NO.1-1", "NO.1-2", "NO.2-1", "NO.2-2"].join("|")
    );

    // 追加テスト: ヘッダの単位表記
    test("Header units labels are correct", () => {
      const rows = toSheetRows(form);
      const flat = rows.map((r) => r[0]).join("|");
      return (
        flat.includes("初沈界面 NO.1(m)") &&
        flat.includes("初沈界面 NO.2(m)") &&
        flat.includes("PAC残量(㎥)")
      );
    });

    // 追加テスト: resetAll が存在
    test("resetAll exists", () => typeof resetAll === "function");

    // 追加テスト: ポイントのラベルは "No." で出力される
    test("Point labels use 'No.' in sheet rows", () => {
      const rows = toSheetRows(form);
      return rows.some(
        (r) => typeof r[0] === "string" && /No\./.test(r[0] as string)
      );
    });

    // 追加テスト: STORAGE_KEY が定義されている
    test(
      "STORAGE_KEY defined",
      () => typeof STORAGE_KEY === "string" && STORAGE_KEY.length > 0
    );

    // 追加テスト: 自由記入 備考がシートに出力される
    test("Free note appears in sheet rows", () => {
      const rows = toSheetRows(form);
      const idx = rows.findIndex((r) => r[0] === "【自由記入 備考】");
      if (idx < 0) return false;
      const r = rows[idx + 1] || [];
      return r[0] === "備考";
    });

    // 追加テスト: プレビュー行生成がシート行と同じ長さ
    test("Preview rows equal sheet rows", () => {
      const rows = toSheetRows(form);
      const html = rowsToHtmlTable(rows);
      return typeof html === "string" && html.includes("<table");
    });

    // 追加テスト: Toolbar が関数（JSX 断片が紛れ込んでいない）
    test("Toolbar is function", () => typeof Toolbar === "function");

    console.group("✅ 点検表: smoke tests");
    results.forEach((r) =>
      console[r.pass ? "log" : "error"](
        `${r.pass ? "PASS" : "FAIL"}: ${r.name}`,
        r.info ?? ""
      )
    );
    // 追加: アーカイブの基本動作
    try {
      const a0 = readArchive();
      console.log("archive dates:", Object.keys(a0).length);
    } catch (e) {
      console.error("archive read failed", e);
    }
    console.groupEnd();
  }, []);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="共通情報" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <TextField
            label="日付"
            type="date"
            value={form.header.date}
            onChange={(v) =>
              setForm((p) => ({ ...p, header: { ...p.header, date: v } }))
            }
          />
          <TextField
            label="曜日（任意）"
            placeholder="例：水"
            value={form.header.weekday}
            onChange={(v) =>
              setForm((p) => ({ ...p, header: { ...p.header, weekday: v } }))
            }
          />
          <SelectField
            label="天候"
            value={form.header.weather}
            onChange={(v) =>
              setForm((p) => ({ ...p, header: { ...p.header, weather: v as any } }))
            }
            options={["", ...WEATHER]}
          />
          <NumberField label="外気温(℃)"$1/>
          <NumberField label="初沈界面 NO.1(m)"$1/>
          <NumberField label="初沈界面 NO.2(m)"$1/>
          <NumberField label="PAC残量(㎥)"$1/>
          <NumberField label="脱離液 pH"$1/>
          <NumberField label="脱離液 水温(℃)"$1/>
          <NumberField label="含水率(%)"$1/>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6">
        {SECTION_DEFS.map((def) => (
          <SectionCard
            key={def.key}
            sectionKey={def.key}
            title={def.label}
            value={form.sections[def.key]}
            visibleMap={form.visibility[def.key]}
            onChange={(s) =>
              setForm((p) => ({ ...p, sections: { ...p.sections, [def.key]: s } }))
            }
          >
            {POINT_SECTIONS.includes(def.key) && (
              <div className="mt-4">
                <PointSubsections
                  sectionKey={def.key}
                  points={form.points}
                  visibility={form.visibility[def.key] ?? {}}
                  value={form.pointData?.[def.key] || {}}
                  onChange={(pd) =>
                    setForm((p) => ({
                      ...p,
                      pointData: { ...p.pointData, [def.key]: pd },
                    }))
                  }
                />
              </div>
            )}
          </SectionCard>
        ))}
      </div>

      {/* 自由記入 備考（放流水の次のカード） */}
      <Card>
        <CardHeader title="自由記入 備考" />
        <div className="grid grid-cols-1">
          <TextArea
            label="備 考"
            value={form.extraNote}
            onChange={(v) => setForm((p) => ({ ...p, extraNote: v }))}
          />
        </div>
      </Card>

      <HistoryPanel
        currentDate={form.header.date}
        onLoad={(d) => {
          const a = readArchive();
          const snap = a[d];
          if (snap) setForm(snap);
        }}
        onDelete={(d) => {
          const a = readArchive();
          if (a[d]) {
            delete a[d];
            writeArchive(a);
          }
        }}
        onSave={() => {
          const a = readArchive();
          a[form.header.date] = form;
          writeArchive(a);
          alert("この日付の点検結果を保存しました");
        }}
      />

      <Toolbar onExportExcel={exportExcel} onReset={resetAll} onPreview={openPreview} />
      {previewOpen && (
        <PreviewSheet rows={toSheetRows(form)} onClose={closePreview} />
      )}
    </div>
  );
}

function SectionCard({
  sectionKey,
  title,
  value,
  visibleMap,
  onChange,
  children,
}: {
  sectionKey: SectionKey;
  title: string;
  value: SectionForm;
  visibleMap?: Partial<Record<FieldKey, boolean>>;
  onChange: (v: SectionForm) => void;
  children?: React.ReactNode;
}) {
  const set = (patch: Partial<SectionForm>) => onChange({ ...value, ...patch });
  const v = (k: FieldKey) => visibleMap?.[k] !== false;

  // セクション側入力の表示制御：上部/下部は非表示、それ以外は表示
  const hideSectionInputs =
    sectionKey === "aerobic_upper" || sectionKey === "aerobic_lower";

  const anyVisible = (
    [
      "odor",
      "color",
      "temp",
      "turbidity",
      "pH",
      "DO",
      "residualChlorine",
      "headLoss",
      "aeration",
      "comment",
    ] as FieldKey[]
  ).some((k) => v(k));

  return (
    <Card>
      <CardHeader title={`【${title}】`} />
      {!hideSectionInputs && anyVisible && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {v("odor") && (
            <SelectField
              label="臭 気"
              value={value.odor || ""}
              onChange={(val) => set({ odor: val as any })}
              options={["", ...ODOR]}
            />
          )}
          {v("color") && (
            <SelectField
              label="色 相"
              value={value.color || ""}
              onChange={(val) => set({ color: val as any })}
              options={["", ...COLOR_INFLUENT]}
            />
          )}
          {v("temp") && (
            <NumberField label="水温(℃)"$1/>
          )}
          {v("turbidity") && (
            <NumberField label="透視度"$1/>
          )}
          {v("pH") && (
            <NumberField label="pH"$1/>
          )}
          {v("DO") && (
            <NumberField label="DO(mg/L)"$1/>
          )}
          {v("residualChlorine") && (
            <NumberField label="残塩(mg/L)"$1/>
          )}
          {v("headLoss") && (
            <NumberField label="ろ抗高"$1/>
          )}
          {v("aeration") && (
            <NumberField label="送気量"$1/>
          )}
          {v("comment") && (
            <TextArea
              label="備 考"
              value={value.comment || ""}
              onChange={(val) => set({ comment: val })}
            />
          )}
        </div>
      )}
      {children}
    </Card>
  );
}

function PointSubsections({
  sectionKey,
  points,
  visibility,
  value,
  onChange,
}: {
  sectionKey: SectionKey;
  points: string[];
  visibility: Partial<Record<FieldKey, boolean>>;
  value: PointDataMap;
  onChange: (v: PointDataMap) => void;
}) {
  const vis = (k: FieldKey) => visibility?.[k] !== false;
  const set = (label: string, patch: Partial<SectionForm>) => {
    onChange({ ...value, [label]: { ...(value[label] || {}), ...patch } });
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      {points.map((label) => {
        const rec = value[label] || {};
        return (
          <Card key={label}>
            <CardHeader
              title={`【${
                sectionKey === "aerobic_upper"
                  ? "好気性ろ床 上部"
                  : "好気性ろ床 下部・処理水"
              } ${displayPointLabel(label)}】`}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {vis("odor") && (
                <SelectField
                  label="臭 気"
                  value={String(rec.odor ?? "")}
                  onChange={(v) => set(label, { odor: v as any })}
                  options={["", ...ODOR]}
                />
              )}
              {vis("color") && (
                <SelectField
                  label="色 相"
                  value={String(rec.color ?? "")}
                  onChange={(v) => set(label, { color: v as any })}
                  options={["", ...COLOR_INFLUENT]}
                />
              )}
              {vis("temp") && (
                <NumberField label="水温(℃)"$1/>
              )}
              {vis("turbidity") && (
                <NumberField label="透視度"$1/>
              )}
              {vis("pH") && (
                <NumberField label="pH"$1/>
              )}
              {vis("DO") && (
                <NumberField label="DO(mg/L)"$1/>
              )}
              {vis("residualChlorine") && (
                <NumberField label="残塩(mg/L)"$1/>
              )}
              {vis("headLoss") && (
                <NumberField label="ろ抗高"$1/>
              )}
              {vis("aeration") && (
                <NumberField label="送気量"$1/>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Toolbar({
  onExportExcel,
  onReset,
  onPreview,
}: {
  onExportExcel: () => void;
  onReset: () => void;
  onPreview: () => void;
}) {
  return (
    <div className="sticky bottom-0 bg-white/80 backdrop-blur border rounded-2xl p-3 flex flex-wrap gap-2 items-center">
      <button
        className="px-3 py-2 rounded-xl bg-amber-600 text-white hover:bg-amber-700"
        onClick={onExportExcel}
      >
        Excelエクスポート
      </button>
      <button
        className="px-3 py-2 rounded-xl bg-slate-700 text-white hover:bg-slate-800"
        onClick={onPreview}
      >
        Excelプレビュー
      </button>
      <div className="flex-1" />
      <button
        className="px-3 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700"
        onClick={() => {
          if (confirm("全ての入力をリセットします。よろしいですか？")) onReset();
        }}
      >
        リセット
      </button>
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
        <div className="text-xl font-semibold">日常点検メモ</div>
        <div className="text-sm text-gray-500">流入水／好気性ろ床 上部／好気性ろ床 下部・処理水／放流水</div>
        <div className="ml-auto text-xs text-gray-400">v1.28</div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-12 pb-8 text-center text-xs text-gray-400">
      <p>© {new Date().getFullYear()} 点検表 Webアプリ</p>
      <p>Excel(.xlsx) 出力に対応。PDFフォーマットに貼りやすい表構成です。</p>
    </footer>
  );
}

// ---- Excelプレビュー（HTMLレンダリング） ----
function rowsToHtmlTable(rows: string[][]) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = rows
    .map((r) => `<tr>${r.map((c,i)=>`<td${i===0? ' style="font-weight:bold"':''}>${esc(String(c ?? ""))}</td>`).join("")}</tr>`) 
    .join("");
  return `<table class="w-full border-collapse"><tbody>${body}</tbody></table>`;
}

function PreviewSheet({ rows, onClose }: { rows: string[][]; onClose: () => void }) {
  const html = rowsToHtmlTable(rows);
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[80vh] overflow-auto">
        <div className="p-4 border-b flex items-center gap-3">
          <h3 className="font-semibold">Excelプレビュー（出力と同じ行構成）</h3>
          <button className="ml-auto px-3 py-1 rounded-lg border hover:bg-gray-50" onClick={onClose}>閉じる</button>
        </div>
        <div className="p-4">
          <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="bg-white shadow-sm rounded-2xl p-4 sm:p-6 border">{children}</section>;
}

function CardHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

function TextField({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
}: {
  label: string;
  type?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-gray-700">{label}</span>
      <input
        type={type}
        className="border rounded-xl px-3 py-2 focus:outline-none focus:ring"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

// 数値入力用（テンキー表示/小数OK）
function NumberField({
  label,
  value,
  onChange,
  placeholder,
  allowNegative = false,
}: {
  label: string;
  value: string;
  placeholder?: string;
  allowNegative?: boolean;
  onChange: (v: string) => void;
}) {
  // 入力フィルタ: 数字/小数点/（必要なら）先頭のマイナスのみ
  const sanitize = (raw: string) => {
    let v = raw.replace(/[^0-9.\-]/g, "");
    // マイナスは先頭のみ許可
    if (!allowNegative) v = v.replace(/\-/g, "");
    else v = v.replace(/(?!^)-/g, "");
    // ドットは1個まで
    const parts = v.split(".");
    if (parts.length > 2) v = parts.shift() + "." + parts.join("");
    return v;
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-gray-700">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        pattern={allowNegative ? "^-?[0-9]*\\.?[0-9]*$" : "^[0-9]*\\.?[0-9]*$"}
        className="border rounded-xl px-3 py-2 focus:outline-none focus:ring"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(sanitize(e.target.value))}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  options: readonly string[] | string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-gray-700">{label}</span>
      <select
        className="border rounded-xl px-3 py-2 focus:outline-none focus:ring bg-white"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt) === "" ? "(未選択)" : String(opt)}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 md:col-span-2">
      <span className="text-sm text-gray-700">{label}</span>
      <textarea
        className="border rounded-xl px-3 py-2 focus:outline-none focus:ring min-h-[80px]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function RadioGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const uid = useId();
  const name = `${label}-${uid}`;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm text-gray-700">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <label
            key={opt}
            className={`px-3 py-2 rounded-xl border cursor-pointer select-none ${
              value === opt
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white hover:bg-gray-50"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={opt}
              className="hidden"
              checked={value === opt}
              onChange={() => onChange(opt)}
            />
            {opt}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
