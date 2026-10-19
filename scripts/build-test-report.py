#!/usr/bin/env python3
"""Build the evidence-based PDF after the PDF skill operation marker has run.

Use the bundled Python runtime, not the system Python. This script is inert until
executed; it never runs tests or changes application source. Optional --with-html
adds a searchable HTML companion containing every matrix/UI record.
"""
from __future__ import annotations

import argparse
import html
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable, Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,
    Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "artifacts" / "test-evidence"
INK = colors.HexColor("#20303D")
MUTED = colors.HexColor("#5E6D79")
ACCENT = colors.HexColor("#C75C2C")
PALE = colors.HexColor("#F6F7F8")
LINE = colors.HexColor("#DCE2E6")
GREEN = colors.HexColor("#28664F")
PAGE_W, PAGE_H = A4
MARGIN = 42
WIDTH = PAGE_W - MARGIN * 2
AREA_LABELS = {
    "advanced-help": "高级设置用途与技术详情", "advanced-numeric": "高级数值边界",
    "advanced-parameters": "高级候选与开关", "advanced-text": "文件信息文本",
    "common-boundaries": "常用数值与时间边界", "common-parameters": "常用功能与参数",
    "compatibility": "格式与编码兼容保护", "drawer": "命令、日志与配置检查",
    "engine": "处理引擎连接", "feedback": "提示反馈", "files": "原生文件操作",
    "gap-semantics": "真实数据与故障场景", "import-preservation": "导入配置保真",
    "input-output": "素材读取与重选恢复", "modal": "帮助弹窗", "navigation": "页面导航",
    "project": "工程保存、回读与撤销", "queue": "任务排队与生命周期",
    "settings-search": "设置分类与搜索",
}


def read_json(name, default=None):
    path = EVIDENCE / name
    if not path.exists():
        return {} if default is None else default
    return json.loads(path.read_text(encoding="utf-8"))


def text(value):
    if value is None:
        return "未提供"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def shorten(value, limit):
    value = re.sub(r"\s+", " ", text(value)).strip()
    return value if len(value) <= limit else value[: limit - 3] + "..."


def font_setup():
    # Arial Unicode has TrueType outlines and a broad Chinese glyph repertoire.
    # Some macOS TTC faces contain CFF outlines unsupported by ReportLab; try and
    # fall back cleanly rather than emitting unreadable placeholder glyphs.
    candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
        Path("/System/Library/Fonts/STHeiti Light.ttc"),
        Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
        Path("/Library/Fonts/Arial Unicode.ttf"),
    ]
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            pdfmetrics.registerFont(TTFont("ReportCN", str(candidate), subfontIndex=0))
            pdfmetrics.registerFontFamily("ReportCN", normal="ReportCN", bold="ReportCN", italic="ReportCN", boldItalic="ReportCN")
            return "ReportCN", str(candidate)
        except Exception:
            continue
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    pdfmetrics.registerFontFamily("STSong-Light", normal="STSong-Light", bold="STSong-Light", italic="STSong-Light", boldItalic="STSong-Light")
    return "STSong-Light", "CID STSong-Light (renderer needs a CJK fallback font)"


FONT, FONT_SOURCE = font_setup()
STYLES = {
    "title": ParagraphStyle("title", fontName=FONT, fontSize=26, leading=34, textColor=INK, spaceAfter=12, wordWrap="CJK"),
    "h1": ParagraphStyle("h1", fontName=FONT, fontSize=19, leading=26, textColor=INK, spaceAfter=12, wordWrap="CJK"),
    "h2": ParagraphStyle("h2", fontName=FONT, fontSize=12, leading=18, textColor=ACCENT, spaceBefore=10, spaceAfter=6, wordWrap="CJK"),
    "body": ParagraphStyle("body", fontName=FONT, fontSize=9.1, leading=14.2, textColor=INK, spaceAfter=6, wordWrap="CJK", splitLongWords=True),
    "small": ParagraphStyle("small", fontName=FONT, fontSize=7.5, leading=10.9, textColor=MUTED, spaceAfter=4, wordWrap="CJK", splitLongWords=True),
    "cell": ParagraphStyle("cell", fontName=FONT, fontSize=8.1, leading=11.5, textColor=INK, wordWrap="CJK", splitLongWords=True),
    "tinycell": ParagraphStyle("tinycell", fontName=FONT, fontSize=7.2, leading=9.5, textColor=INK, wordWrap="CJK", splitLongWords=True),
    "th": ParagraphStyle("th", fontName=FONT, fontSize=8.1, leading=11.5, textColor=colors.white, wordWrap="CJK"),
    "code": ParagraphStyle("code", fontName=FONT, fontSize=7.3, leading=11.2, textColor=INK, backColor=PALE, borderPadding=7, spaceAfter=7, wordWrap="CJK", splitLongWords=True),
    "caption": ParagraphStyle("caption", fontName=FONT, fontSize=7.3, leading=10.5, textColor=MUTED, alignment=TA_CENTER, spaceAfter=6, wordWrap="CJK"),
}


def p(value, kind="body", raw=False):
    value = text(value).replace("\u2011", "-").replace("\u2013", "-").replace("\u2014", "-")
    return Paragraph(value if raw else html.escape(value).replace("\n", "<br/>"), STYLES[kind])


def table(headers, rows, widths, compact=False):
    cell_kind = "tinycell" if compact else "cell"
    data = [[p(x, "th") for x in headers]] + [[p(x, cell_kind) for x in row] for row in rows]
    result = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    result.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5 if compact else 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5 if compact else 6),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW", (0, 1), (-1, -1), 0.35, LINE),
    ]))
    return result


def tap_counts(path, fallback):
    result = {"tests": fallback.get("cases", 0), "pass": fallback.get("passed", 0), "fail": fallback.get("failed", 0), "skipped": fallback.get("skipped", 0), "source": "core-summary.json fallback"}
    if path.exists():
        log = path.read_text(encoding="utf-8", errors="replace")
        for key in ["tests", "pass", "fail", "skipped", "cancelled"]:
            values = re.findall(rf"^# {key} (\d+)\s*$", log, re.MULTILINE)
            if values:
                result[key] = int(values[-1])
        result["source"] = path.name
    return result


def normalize_status(value):
    value = str(value or "pending").lower()
    if value in ["ok", "pass", "passed", "通过", "success"]:
        return "pass"
    if value in ["fail", "failed", "失败", "error"]:
        return "fail"
    return "pending"


def status_cn(value):
    return {"pass": "通过", "fail": "失败", "pending": "待验证"}[normalize_status(value)]


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT, 7.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, PAGE_H - 25, "FFmpeg Workbench  /  功能与桌面交互测试")
    canvas.setStrokeColor(LINE)
    canvas.line(MARGIN, PAGE_H - 31, PAGE_W - MARGIN, PAGE_H - 31)
    canvas.line(MARGIN, 32, PAGE_W - MARGIN, 32)
    canvas.drawString(MARGIN, 20, "测试范围以本报告和证据清单为准")
    canvas.drawRightString(PAGE_W - MARGIN, 20, f"第 {doc.page} 页")
    canvas.restoreState()


OBSERVATIONS = {
    "video-bitrate": "核对编码器目标码率日志及实际视频流；已移除 CRF/量化质量模式。",
    "video-maxrate": "核对 x264 的 vbv_maxrate 与配套缓冲区参数。",
    "video-buffer": "核对 x264 的 vbv_bufsize 与配套最大码率参数。",
    "keyframe-interval": "g=1 为全 I 帧；g=10 间隔 10 帧；g=1000 核对编码参数，短源不足以观察完整间距。",
    "b-frames": "核对编码器 bframes 限制及输出 has_b_frames。",
    "threads": "核对自动及 1/64 线程的实际 x264 参数；不作速度或其他编码器性能基准。",
    "pixel-format": "probe 核对 yuv420p、10 位 yuv420p10le、yuv444p。",
    "h264-profile": "probe 核对 Baseline、Main、High 播放兼容配置。",
    "h264-level": "probe 核对 3.1、4.0、4.1、4.2、5.1 等级。",
    "color-range": "probe 核对 pc/tv；tv 配合 BT.709 矩阵使默认 VUI 标记可观测。",
    "color-space": "probe 核对 BT.709、BT.470BG、SMPTE170M、BT.2020NC 标记。",
    "color-primaries": "probe 核对所选原色坐标标记；未证明实际色彩转换。",
    "color-transfer": "probe 核对 BT.709、PQ、HLG 标记；未证明 HDR 转换。",
    "display-aspect": "probe 核对五种显示比例；等价分数按数值比较。",
    "frame-timing": "变帧率素材：CFR 统一帧间隔；VFR/passthrough 保留逐帧时间戳。",
    "audio-channels": "probe 核对 1、2、6 声道输出。",
    "audio-sample-format": "使用适配编码器，probe 核对 s16、s32、fltp。",
    "flac-compression": "四种强度均执行；强度 8 对比解码 PCM24 的 SHA256 完全一致。",
    "shortest": "较长声音/较短视频素材，输出在约 1.2 秒最短流处结束。",
    "disable-subtitles": "输入包含字幕轨，输出不包含字幕轨。",
    "disable-data": "旧矩阵仅普通执行；新增真实数据轨与 GUI 复验见补齐语义页。",
    "faststart": "读取 MP4 盒位置，确认 moov 索引位于 mdat 媒体数据之前。",
    "remove-metadata": "源素材含继承标题/作者，输出确认这些标签被移除。",
    "remove-chapters": "源素材含两个章节，输出章节数为 0。",
    "title": "probe 核对中文标题被原样写入。",
    "artist": "probe 核对中文作者被原样写入。",
    "comment": "probe 核对空格、双引号和等号备注被原样写入。",
    "muxing-queue": "旧矩阵仅普通执行；新增默认阈值耗尽与 GUI 复验见补齐语义页。",
}

DEFECTS_CN = {
    "CORE-01": "停用的格式节点干扰了当前测试素材替换。",
    "CORE-02": "替换素材时删除了原本应保留的停用素材节点。",
    "CORE-03": "工程 JSON 的节点类型数组被错误转换后通过校验。",
    "CORE-04": "非法功能枚举值可能生成无效命令参数。",
    "CORE-05": "从 FLAC 切换其他音频格式后残留专用压缩设置。",
    "CORE-06": "切换音频编码器后残留不兼容的采样精度设置。",
    "CORE-07": "整数控件接受了 FFmpeg 不适用的空白或指数写法。",
}


def rust_counts(native):
    result = {"tests": len(native.get("tests", [])), "pass": native.get("passed", 0), "fail": native.get("failed", 0), "source": "native-tests-summary.json"}
    candidates = sorted([name for name in ["final-native-tests.log", "native-tests.log"] if (EVIDENCE/name).exists()], key=lambda name:(EVIDENCE/name).stat().st_mtime, reverse=True)
    for name in candidates:
        path = EVIDENCE / name
        if not path.exists():
            continue
        matches = re.findall(r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored", path.read_text(errors="replace"))
        if matches:
            passed, failed, ignored = max((tuple(map(int, m)) for m in matches), key=lambda m: m[0] + m[1])
            result = {"tests": passed + failed, "pass": passed, "fail": failed, "ignored": ignored, "source": name}
            break
    return result


def matrix_dataset():
    rerun = "gui-full-matrix-rerun/artifacts/test-evidence/feature-matrix.json"
    if (EVIDENCE / rerun).exists():
        return read_json(rerun, {"results": []}), rerun, "10/14 独立参数复跑"
    return read_json("feature-matrix.json", {"results": []}), "feature-matrix.json", "10/13 历史参数矩阵（本轮复跑缺失）"


def gui_dataset():
    inventory = read_json("gui-full-inventory.json", {"cases": [], "commonControls": [], "advancedControls": []})
    result = read_json("gui-full-results.json", {"cases": [], "notes": [], "defects": []})
    latest = {case["id"]: case for case in result.get("cases", []) if case.get("id")}
    planned = []
    for item in inventory.get("cases", []):
        supplied = latest.get(item.get("id"), {})
        merged = {**item, **supplied}
        # A results file may be initialized by copying all pending inventory
        # rows. Presence alone is not proof of an action or an actual result.
        merged["recorded"] = bool(supplied) and (normalize_status(supplied.get("status")) in ["pass", "fail"] or bool(supplied.get("evidence")) or bool(supplied.get("command")) or bool(supplied.get("output")))
        merged["status"] = latest.get(item.get("id"), {}).get("status", "pending")
        planned.append(merged)
    known = {case.get("id") for case in planned}
    extra = [{**case, "recorded": True} for id_, case in latest.items() if id_ not in known]
    return inventory, result, planned, extra


def case_counts(cases):
    return {"planned": len(cases), "pass": sum(normalize_status(c.get("status")) == "pass" for c in cases), "fail": sum(normalize_status(c.get("status")) == "fail" for c in cases), "pending": sum(normalize_status(c.get("status")) == "pending" for c in cases), "recorded": sum(bool(c.get("recorded")) for c in cases)}


def gui_count_text(cases):
    count = case_counts(cases)
    return f"{count['pass']}/{count['planned']}通过，{count['fail']}失败，{count['pending']}待验"


def gui_cases_for(cases, control):
    if control == "outputPath":
        return [case for case in cases if case.get("controlId") == control or case.get("id", "").startswith("OUTPUT-")]
    return [case for case in cases if case.get("controlId") == control]


def append_screenshot(story, candidates, max_height=255):
    for name in candidates:
        path = Path(str(name))
        if not path.is_absolute():
            path = (ROOT / path) if str(path).startswith("artifacts/") else EVIDENCE / path
        if not path.exists() or path.suffix.lower() not in [".png", ".jpg", ".jpeg"]:
            continue
        iw, ih = ImageReader(str(path)).getSize()
        scale = min(WIDTH / iw, max_height / ih)
        story.extend([Spacer(1, 8), Image(str(path), width=iw * scale, height=ih * scale), p(f"实际截图：{path.name}；仅说明所示时刻，完整状态以本轮操作记录为准。", "caption")])
        return True
    return False


def build_pdf(output):
    matrix, matrix_path, matrix_label = matrix_dataset()
    coverage = read_json("feature-matrix-coverage.json", {"settings": []})
    core = read_json("core-summary.json")
    native = read_json("native-tests-summary.json")
    desktop = read_json("desktop-build-summary.json")
    historical = read_json("ui-tests.json", {"cases": [], "notes": []})
    historical_matrix = read_json("feature-matrix.json", {"results": []})
    output_verification = read_json("gui-full-ui/gui-output-verification.json", {"runs": []})
    verified_outputs = output_verification.get("runs", [])
    verified_pass = sum(item.get("status") == "pass" for item in verified_outputs)
    verified_fail = len(verified_outputs) - verified_pass
    large_recovery = read_json("gui-full-ui/queue-recovery-output-proof.json")
    inventory, current, planned, extra = gui_dataset()
    cases = planned + extra
    counts = case_counts(planned)
    js = tap_counts(EVIDENCE / "final-js-tests.log", core.get("allJavaScriptTests", {}))
    rust = rust_counts(native)
    results = matrix.get("results", [])
    real = sum(any(str(e).endswith(".probe.json") for e in row.get("evidence", [])) for row in results)
    matrix_pass = sum(row.get("status") == "pass" for row in results)
    missing_evidence = [c for c in cases if normalize_status(c.get("status")) == "pass" and (not c.get("actual") or not c.get("evidence"))]
    execution_cases = [c for c in cases if c.get("recorded") and c.get("output")]
    execution_gaps = [c for c in planned if c.get("requiresGuiExecution") and normalize_status(c.get("status")) == "pass" and not c.get("output")]
    defect_values=current.get("defects",[])
    if isinstance(defect_values,dict):defect_values=list(defect_values.values())
    unresolved_defects=[d for d in defect_values if isinstance(d,dict) and d.get("status") not in ["fixed-gui-retested","resolved-gui-retested","verified","pass","closed"]]
    complete = bool(planned) and counts["pass"] == counts["planned"] and not missing_evidence and not execution_gaps and not unresolved_defects
    conclusion = "本轮清单范围内的原生 GUI 验收全部通过" if complete else "本轮 GUI 验收仍有失败、未验或证据待补项"
    if complete and (js["fail"] or rust["fail"] or matrix_pass != len(results)):
        conclusion = "GUI 清单验收已完成；支持性回归仍有失败项"
    if complete and verified_fail:
        conclusion = "GUI 操作已完成；独立产物核验仍有失败项"
    fixture = read_json("gui-full-fixtures/manifest.json")
    settings_by_id = {item.get("id"): item for item in coverage.get("settings", [])}
    for item in settings_by_id.values():
        item["realExecutionCount"] = sum(row.get("feature")==item.get("id") and any(str(e).endswith(".probe.json") for e in row.get("evidence", [])) for row in results)
    common = inventory.get("commonControls", [])
    advanced = inventory.get("advancedControls", [])
    now = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M UTC+08:00")
    story = []
    add = story.append
    def page(title):
        if story:
            add(PageBreak())
        add(p(title, "h1"))
    def note(value):
        add(p(value, "small"))
    def control_rows(items):
        return [[item.get("label", item.get("id")), gui_count_text(gui_cases_for(planned, item.get("id"))), shorten(item.get("verify", item.get("description", "")), 108)] for item in items]
    def recorded_summary(selected, limit=12):
        selected = [case for case in selected if case.get("recorded")]
        if not selected:
            add(p("本轮尚无相应原生操作结果。清单预期不是实际结果，旧 CLI 或单测不计为本轮通过。"))
            return
        add(table(["用例 / 操作", "状态", "实际观察"], [[shorten(c.get("title", c.get("action", c.get("id"))), 38), status_cn(c.get("status")), shorten(c.get("actual"), 125)] for c in selected[:limit]], [157, 44, WIDTH - 201], compact=True))
        if len(selected) > limit:
            note(f"其余 {len(selected)-limit} 项详见本轮 JSON / 可搜索 HTML，PDF 不铺开全部逐项记录。")

    # 1. Current native GUI results lead; historical evidence cannot fill gaps.
    page("FFmpeg Workbench\n完整界面操作验收报告")
    note(f"生成：{now}；本轮结果源：gui-full-results.json；平台：macOS arm64。")
    add(p(conclusion, "h2"))
    add(table(["本轮原生 GUI 清单", "实际记录"], [
        ["计划 / 已有结果", f"{counts['planned']} 项 / {counts['recorded']} 项；另有 {len(extra)} 项补充记录"],
        ["通过 / 失败 / 待验", f"{counts['pass']} / {counts['fail']} / {counts['pending']}"],
        ["通过但操作证据不完整", f"{len(missing_evidence)} 项缺实际描述或 evidence；不会据此宣称全验收完成"],
        ["缺陷复验状态待补", f"{len(unresolved_defects)} 项；修复描述不代替最终复验状态"],
        ["GUI 启动产物记录", f"{len(execution_cases)} 项记录有 output 引用；必需执行却缺产物引用：{len(execution_gaps)} 项"],
        ["GUI 产物独立核验", f"{verified_pass}/{len(verified_outputs)} 通过，{verified_fail} 失败；另有大队列恢复独立 proof，避免把控件项数当产物数"],
        ["验收范围", f"{len(common)} 个常用控件、{len(advanced)} 个高级控件及导航/文件/队列/保护等操作"],
    ], [182, WIDTH - 182]))
    add(p("支持性自动化结果", "h2"))
    add(table(["验证层", "结果", "计数口径"], [
        ["JavaScript", f"{js['pass']}/{js['tests']}", "读取最终 TAP；控件、兼容规则与进度检查包含在总数中。"],
        [matrix_label, f"{matrix_pass}/{len(results)}", f"{real} 次真实编码已包含在矩阵数中，不再相加；独立于 GUI 操作。"],
        ["Rust 本机执行", f"{rust['pass']}/{rust['tests']}", f"读取 {rust['source']}；不能替代 GUI 控件操作。"],
        ["10/13 历史记录", f"{len(historical.get('cases', []))} 项 GUI", f"另有历史矩阵 {len(historical_matrix.get('results', []))} 项；均不填补本轮 pending。"],
    ], [112, 79, WIDTH - 191]))
    note("本报告的全量指当前可见有限候选与操作清单。数值、文本、路径采用代表值与边界；不声称遍历无限文本、4096 个自定义偶数高度或所有参数组合。")

    # 2. Inventory and operation evidence rule.
    page("范围与证据：怎样判断已验收")
    add(p(inventory.get("scope", {}).get("exhaustiveness", "未找到界面清单，不能宣称完整覆盖。")))
    add(p("每项必须实际操作原生界面，并记录选择、反馈、命令或保存工程。导入预设只能作为前置，不能代替点击该控件；CLI、核心单测和 DOM 直改不能冒充原生 GUI 操作。六个功能入口必须由 GUI 启动并检查产物。"))
    areas = sorted({case.get("area", "未分类") for case in planned})
    add(table(["界面区域", "通过 / 失败 / 待验", "清单项"], [[AREA_LABELS.get(area, area), f"{case_counts([c for c in planned if c.get('area')==area])['pass']} / {case_counts([c for c in planned if c.get('area')==area])['fail']} / {case_counts([c for c in planned if c.get('area')==area])['pending']}", str(len([c for c in planned if c.get('area')==area]))] for area in areas], [211, 179, WIDTH - 390], compact=True))
    note("有限下拉候选逐个检查；开关检查双态和清除/恢复；数值检查有效代表、min/max 及非法边界。兼容性禁用、只读保护、帮助展开、取消对话框也属于独立验收项。")

    # 3-4. Every common control and six entry points.
    page("六个功能入口与常用控件（1/2）")
    purpose = next((item for item in common if item.get("id") == "purpose"), {})
    add(table(["功能入口", "本轮 GUI 状态", "产物证据"], [[label, status_cn(next((c.get("status") for c in planned if c.get("id")==f"COMMON-purpose-{value}"), "pending")), "已引用" if any(c.get("output") for c in planned if c.get("id")==f"COMMON-purpose-{value}") else "尚未引用"] for value, label in purpose.get("values", [])], [120, 160, WIDTH - 280]))
    add(Spacer(1, 10)); add(table(["常用控件", "GUI 覆盖", "核对重点"], control_rows(common[:9]), [116, 137, WIDTH - 253], compact=True))
    page("全部常用控件（2/2）")
    add(table(["常用控件", "GUI 覆盖", "核对重点"], control_rows(common[9:]), [116, 137, WIDTH - 253], compact=True))
    add(p("产物判定", "h2")); add(p("格式/编码检查实际流和容器，裁剪检查时长，尺寸/旋转/镜像检查画面，静音/提取检查音视频存在性，音量检查解码 RMS。只见控件选中不足以证明输出效果；当前摘要与执行引用分开计数。"))

    # 5-6. All 28 advanced controls: current GUI and prior semantic evidence.
    for number, subset in enumerate([advanced[:14], advanced[14:]], 1):
        page(f"全部高级配置（{number}/2）")
        note(f"GUI 覆盖为本轮实际控件操作；CLI 次数来自{matrix_label}，两者不互相替代。默认/重置、帮助/兼容禁用也可能计入该控件清单。")
        add(table(["设置", "本轮 GUI", "CLI 次数", "语义核对 / 限定"], [[item.get("label", item.get("id")), gui_count_text(gui_cases_for(planned,item.get("id"))), str(settings_by_id.get(item.get("id"), {}).get("realExecutionCount", 0)), OBSERVATIONS.get(item.get("id"), "见逐项记录")] for item in subset], [100, 104, 47, WIDTH - 251], compact=True))
        note("颜色范围、色域、PQ/HLG 等验证标签写入，不等于完成 SDR/HDR 色彩转换。独立 CLI 执行不计成本轮原生控件操作通过。")

    # 7. Non-parameter UI summarized without listing the entire inventory.
    page("导航、工程、文件与保护操作")
    operation_areas = ["navigation","project","modal","engine","files","settings-search","drawer","feedback","queue","compatibility","import-preservation"]
    add(table(["操作区域", "本轮 GUI 覆盖"], [[AREA_LABELS.get(area, area), gui_count_text([case for case in planned if case.get("area")==area])] for area in operation_areas], [186, WIDTH - 186], compact=True))
    add(p("已记录的代表操作", "h2")); recorded_summary([c for c in cases if c.get("area") in operation_areas], 7)

    # 8. Outputs actually started through GUI.
    page("GUI 实际处理与产物")
    note(f"本轮独立核验 {len(verified_outputs)} 个 GUI 完成产物，{verified_pass} 通过、{verified_fail} 失败；这些产物由原生界面实际启动，核验方读取媒体、解码和哈希。{len(execution_cases)} 项控件结果引用产物，不能把多个控件引用相加成任务数。")
    chosen_ids = ["common-c1","common-c4-retest","height-max-8192","flac-2","advanced-video-5","advanced-numeric-1000","metadata-literal","faststart-true","shortest-true","vfr-source-vfr","data-source-true","queue-unknown-duration-outside"]
    chosen_outputs = [row for id_ in chosen_ids for row in verified_outputs if row.get("id")==id_]
    def output_description(row):
        a=row.get("actual",{});v=a.get("video") or {};sound=a.get("audio") or {}
        return f"{a.get('duration','?')} 秒；" + (f"{v.get('codec_name')} {v.get('width')}×{v.get('height')} / {v.get('nb_read_frames','?')} 帧；" if v else "无视频；") + (f"{sound.get('codec_name')} / {sound.get('channels')} 声道" if sound else "无声音")
    if chosen_outputs:
        add(table(["独立核验产物", "状态", "实际媒体"], [[row.get("id"),status_cn(row.get("status")),output_description(row)] for row in chosen_outputs], [151,43,WIDTH-194],compact=True))
    else:
        add(p("尚无本轮 GUI 产物独立核验记录。参数矩阵输出不能填充这一页。"))
    if large_recovery:
        note(f"另有大队列恢复：{large_recovery.get('status','待验')}；{large_recovery.get('actual',{}).get('videoFrames','?')} 帧、{large_recovery.get('actual',{}).get('videoDurationSeconds','?')} 秒。大测试文件核验后按预算清理，保留 SHA256/probe/proof。")
    if execution_gaps:
        note("缺产物引用的必需执行项：" + ", ".join(c.get("id", "") for c in execution_gaps[:12]))
    append_screenshot(story,["gui-full-ui/current-progress-completed.png"],155)

    # 9. Progress and genuine current screenshots.
    page("处理进度与任务队列反馈")
    add(table(["信息", "验收要求"], [["阶段与进度","准备/处理/保存明确；未知时长不虚构百分比。"],["时长与剩余","已用、已处理、总长和预计剩余可解释；裁剪后总长正确。"],["速度与帧数","速度倍数、FPS、帧数、码率和大小有真实数据；无 NaN/Infinity。"],["任务隔离","队列任务使用不可变命令快照；切换详情不混淆日志。"],["取消与失败","取消不宣称成功；错误与输出不完整不得误报保存成功。"]], [111,WIDTH-111]))
    progress_cases = [c for c in cases if c.get("area")=="queue" or "progress" in c.get("id", "").lower()]
    note("本轮进度/队列："+gui_count_text(progress_cases))
    images = ["gui-full-ui/current-progress-running.png","gui-full-ui/current-progress-completed.png"] + [e for c in progress_cases if c.get("recorded") for e in c.get("evidence", []) if isinstance(e,str) and e.lower().endswith((".png",".jpg"))]
    if not append_screenshot(story, images, 245):
        note("尚无本轮关联的原生进度截图；不复用 10/13 截图冒充新验收。")

    # 10. Before/after defects, using only provided result data.
    defects = current.get("defects", [])
    if isinstance(defects, dict):
        defects = list(defects.values())
    if defects:
        chunks=[defects[i:i+6] for i in range(0,len(defects),6)]
        for index,chunk in enumerate(chunks,1):
            page(f"缺陷修复与前后对照（{index}/{len(chunks)}）")
            note(f"共 {len(defects)} 项全部列出，不截断新增项。状态和 afterEvidence 以最终 GUI 结果为准；有修复描述不等于复验完成。")
            add(table(["缺陷", "修复前", "修复后 / 复验状态"], [[shorten(d.get("id","")+" "+d.get("title",d.get("description","")),65),shorten(d.get("before",d.get("actualBefore","未提供修复前证据")),135),shorten(d.get("after",d.get("actualAfter","未提供复验")),145)+"\n状态："+({"fixed-gui-retested":"已修复，界面复测通过"}.get(d.get("status"),d.get("status","未提供")))] if isinstance(d,dict) else [shorten(d,65),"未提供","未提供"] for d in chunk],[113,171,WIDTH-284],compact=True))
    else:
        page("缺陷修复与前后对照")
        add(p("本轮尚未提供 defects 前后对照，不能宣称发现项已修复。"))
    add(p("历史核心逻辑修复", "h2"))
    add(table(["编号", "修复内容", "历史状态"], [[d.get("id",""), DEFECTS_CN.get(d.get("id"),d.get("description","")), "历史回归通过" if d.get("status")=="fixed and regression passed" else d.get("status","未提供")] for d in core.get("fixedDefects",[])], [59,WIDTH-170,111], compact=True))
    note("历史回归通过不自动等于本轮 GUI 已复验；本轮以缺陷 after 和关联用例为准。")

    # 11. Newly supplied semantic fixtures, distinguishing CLI and GUI proof.
    page("补齐语义缺口：数据轨与封装队列")
    queue = fixture.get("queueAnalysis", {}).get("defaultThresholdReproduced", {})
    add(p("真实附加数据轨", "h2")); add(p("真实素材包含 bin_data 附加数据流。显式映射并复制时可保留，加入 -dn 后移除；默认自动选流本就忽略数据流，因此界面验收同时记录这一因果限制。"))
    data_gui = gui_cases_for(cases,"disable-data")
    note("本轮 data 控件："+gui_count_text(data_gui))
    add(p("默认自动选流本来就不复制 data，输出无 data 只能证明结果；显式 -map 0 的 CLI 对照才证明 -dn 的删除因果。原生 GUI 必须实际选择含 bin_data 的源、操作开关、启动处理并检查输出。"))
    add(p("默认阈值队列耗尽", "h2"))
    if queue:
        add(table(["CLI 预确认", "实际观察"], [["现有 GUI 可选设置","MP4/H.264、原尺寸、画质优先、192 kbps 声音，封装等待队列设为 1"],["默认阈值故障",f"exit={queue.get('exitCode')}，queueExhausted={queue.get('queueExhausted')}；源{queue.get('sourceVideoFrames')}帧，输出{queue.get('outputVideoFrames')}帧。"],["证据", "\n".join(queue.get("evidence",[]))]], [133,WIDTH-133], compact=True))
    else:
        note("尚无默认阈值故障预确认数据；不宣称完成故障注入。")
    note("本轮 muxing-queue 控件："+gui_count_text(gui_cases_for(cases,"muxing-queue")))
    if large_recovery.get("status")=="pass":
        recovery=large_recovery.get("actual",{})
        add(p(f"本轮 GUI 恢复产物已独立确认 {recovery.get('videoFrames')} 帧、{recovery.get('videoDurationSeconds')} 秒；queue=1 和 1024 的失败输出不存在。实际恢复选择为 65536，不能把先前仍不足的 1024 称为恢复成功。CLI 预确认与这些原生 GUI 证据分开。"))
    else:
        add(p("CLI 预确认不等于 GUI 失败提示或修复已通过。需实际由 GUI 运行失败与恢复路径并核对帧数/输出发布；FFmpeg 返回 0 本身不足以证明完整成功。"))
    note("其他新素材覆盖字幕/章节/继承元数据、双向最短流、无音频、纯音频、损坏输入和 VFR。准备素材不计验收通过，详见夹具 manifest 与本轮实际结果。")
    add(p("独立产物核验的语义口径", "h2"))
    for value in [
        "码率/VBV：除界面命令外，还从 GUI 产物 H.264 用户数据 SEI 提取实际 x264 bitrate/vbv_maxrate/vbv_bufsize；不要求短片平均码率等于目标。",
        "FLAC：按选择的声道/采样率重建 PCM 参考，解码哈希一致；s16 为 16 位，选择 s32 存储格式时本机 FLAC 的有效精度为 24 位。",
        "VFR：使用真实不均匀时间戳源；CFR 补帧并统一间隔，VFR/passthrough 逐帧时间戳与源一致。",
        "最短流：同时核对音视频和容器时长，允许帧时间基与 AAC 尾帧。g=1000 在短源上以 SEI 确认上限，未声称观察到完整 1000 帧间隔。",
    ]:note(value)

    # 12. Automated support and environment are secondary evidence.
    page("支持性回归与运行环境")
    add(table(["层级", "通过 / 总数", "证据"], [["JavaScript",f"{js['pass']}/{js['tests']}",js['source']],["Rust",f"{rust['pass']}/{rust['tests']}",rust['source']],[matrix_label,f"{matrix_pass}/{len(results)}",f"{matrix_path}；其中{real}次真实输出"],["GUI 完成产物核验",f"{verified_pass}/{len(verified_outputs)}","gui-full-ui/gui-output-verification.json"]], [124,96,WIDTH-220]))
    add(p("矩阵观测方法", "h2")); add(p("本轮独立参数复跑检查 codec、容器、尺寸、时长、帧率、声道、采样率和标签；旋转/镜像比较解码图像，音量比较 RMS，FLAC 比较共同 PCM24 哈希，CFR/VFR 比较逐帧时间戳。这些支持性证据不替代原生控件操作。GUI 完成产物再由独立核验读取实际媒体，两类记录分开计数。"))
    add(table(["环境", "本次证据"], [["系统",native.get("platform","未提供")],["FFmpeg / FFprobe",native.get("ffmpeg","未提供")+"\n"+native.get("ffprobe","未提供")],["Node / Rust",matrix.get("environment",{}).get("node","未提供")+"\n"+native.get("rust","未提供")],["桌面包",desktop.get("bundle","未提供")+"；"+desktop.get("signature","未提供")],["SHA256",desktop.get("sha256","尚未提供")]], [112,WIDTH-112]))

    # 13. Unresolved and untested remain visible.
    page("未解决、待验与适用限制")
    unfinished = [c for c in planned if normalize_status(c.get("status"))!="pass"]
    add(p(f"本轮仍有 {counts['fail']} 项失败、{counts['pending']} 项待验。未完成项不会用历史通过、CLI 输出或清单 expected 替代。"))
    if unfinished:
        add(table(["区域", "失败 / 待验", "代表编号"], [[area, f"{sum(normalize_status(c.get('status'))=='fail' for c in unfinished if c.get('area')==area)} / {sum(normalize_status(c.get('status'))=='pending' for c in unfinished if c.get('area')==area)}", ", ".join(c.get("id","") for c in unfinished if c.get("area")==area)[:100]] for area in areas if any(c.get("area")==area for c in unfinished)], [117,67,WIDTH-184], compact=True))
    for value in ["仅 macOS arm64，Windows/Linux 原生路径、打包与进程树未验证。","不代表长视频、真实 HDR/广色域、所有设备素材、全部编码器或性能基准已验证。","无限数值/文本、所有路径、所有参数笛卡尔积不属于本清单穷举。","复杂滤镜图、流媒体、全 FFmpeg CLI 及重启后的持久队列恢复不在当前功能范围。"]:
        note("• "+value)
    note("• 受控 wrapper 仅用于版本检查延迟、准备阶段取消、探测失败/超时等故障路径；不是速度基准，也不冒充真实编码产物。")
    note("• 本机 Documents 中新素材曾在导入路径引用后仅输出 banner 等待；经原生更换素材重选后实际编码成功。应使用原生重选恢复访问；具体 OS 授权机制仍属推断。44 秒是 UI 等待时间，不是已编码 44 秒。合法裸 H.264 无 duration 与读取失败是不同状态：前者已有完整产物证明，后者以对应 GUI 复验为准。")

    # 14. Reproduction, history and complete details.
    page("复现、历史与完整证据")
    for command in ["npm test","node --import tsx scripts/test-feature-matrix.ts","source .tools/env.sh\ncargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored"]:
        add(p(command,"code"))
    add(table(["文件", "含义"], [["gui-full-inventory.json","本轮完整待办和有限候选清单；expected不是结果。"],["gui-full-results.json","本轮原生操作、实际结果、命令/产物/截图、全部缺陷前后对照。"],["gui-full-ui/gui-output-verification.json",f"{len(verified_outputs)}个 GUI 完成产物的独立核验、SHA256、RMS、SEI、帧/元数据等。"],["gui-full-fixtures/manifest.json","真实语义与故障素材、CLI预确认及限制。"],[matrix_path,f"{matrix_label}：{len(results)}项矩阵/{real}次真实编码，互为包含不相加。"],["feature-matrix.json / ui-tests.json","10/13历史参数和桌面记录，不计入本轮 GUI 覆盖。"],["final-js-tests.log / native-tests.log","读取最终动态回归结果。"],["desktop-build-summary.json","实际交付包构建、签名和哈希。"]],[179,WIDTH-179],compact=True))
    note(f"10/13历史记录：{len(historical.get('cases',[]))}项，{sum(normalize_status(c.get('status'))=='pass' for c in historical.get('cases',[]))}通过、{sum(normalize_status(c.get('status'))=='fail' for c in historical.get('cases',[]))}失败。历史问题是否解决请查本轮对应复验，不能直接从总数推断。")
    for value in current.get("notes",[])[:4]:
        note(shorten(value,180))
    note(f"完整逐项明细查看 JSON 与 --with-html 可搜索 HTML；PDF仅摘要，不铺开本轮 {len(planned)} 项清单。证据根目录：{EVIDENCE}")
    output.parent.mkdir(parents=True,exist_ok=True)
    document = SimpleDocTemplate(str(output),pagesize=A4,rightMargin=MARGIN,leftMargin=MARGIN,topMargin=46,bottomMargin=46,title="FFmpeg Workbench 完整界面操作验收报告",author="FFmpeg Workbench",pageCompression=1,allowSplitting=True)
    document.build(story,onFirstPage=header_footer,onLaterPages=header_footer)
    return {"pdf":str(output),"font":FONT_SOURCE,"currentGui":counts,"additionalGuiRecords":len(extra),"missingEvidence":len(missing_evidence),"missingGuiOutput":len(execution_gaps),"historicalUi":len(historical.get("cases",[])),"js":js,"native":rust,"matrix":{"label":matrix_label,"source":matrix_path,"cases":len(results),"passed":matrix_pass,"realExecutions":real},"independentGuiOutputs":{"cases":len(verified_outputs),"passed":verified_pass,"failed":verified_fail},"conclusion":conclusion}


def build_html(output):
    matrix, matrix_path, matrix_label = matrix_dataset()
    historical_matrix = read_json("feature-matrix.json", {"results": []})
    verification = read_json("gui-full-ui/gui-output-verification.json", {"runs": []})
    ui = read_json("ui-tests.json", {"cases": [], "notes": []})
    inventory, current, planned, extra = gui_dataset()
    payload = json.dumps({"matrix": matrix, "matrixLabel": matrix_label, "matrixPath": matrix_path, "historicalMatrix": historical_matrix, "verification": verification, "ui": ui, "inventory": inventory, "currentGui": current, "mergedGuiCases": planned + extra}, ensure_ascii=False).replace("</", "<\\/")
    template = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FFmpeg Workbench 测试明细</title>
<style>body{font:14px/1.6 system-ui,sans-serif;color:#20303d;background:#f6f7f8;margin:0}main{max-width:1150px;margin:35px auto;padding:0 24px}h1{font-size:26px}input,select{padding:10px;border:1px solid #ccd4d9;border-radius:7px;margin:0 8px 12px 0}input{width:min(600px,80%)}article{background:white;padding:18px;margin:12px 0;border:1px solid #dce2e6;border-radius:9px}summary{cursor:pointer;font-weight:600}pre{font:12px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7f8;padding:12px}.pass{color:#28664f}.fail{color:#b53131}.pending{color:#9a641a}.note{color:#5e6d79}button{padding:8px}</style>
<main><h1>FFmpeg Workbench 测试明细</h1><p class="note">本轮原生 GUI 记录优先；未记录项保持 pending。10/14 独立参数复跑、GUI 产物独立核验、10/13 历史矩阵和桌面记录分别列出，不填充本轮控件通过。真实编码次数已包含在矩阵内，不累加为功能数。</p><input id="search" placeholder="搜索功能、用例编号、参数、预期或结果"><select id="layer"><option value="本轮原生 GUI">本轮原生 GUI</option><option value="">全部验证层</option><option value="__MATRIX_LABEL__">__MATRIX_LABEL__</option><option value="GUI 产物独立核验">GUI 产物独立核验</option><option value="10/13 历史参数矩阵">10/13 历史参数矩阵</option><option value="10/13 历史 GUI">10/13 历史 GUI</option></select><select id="status"><option value="">全部状态</option><option value="pass">通过</option><option value="fail">失败</option><option value="pending">待验证</option></select><p id="count"></p><details><summary>本轮缺陷与说明</summary><pre id="notes"></pre></details><div id="list"></div></main>
<script id="payload" type="application/json">__PAYLOAD__</script><script>
const data=JSON.parse(document.getElementById('payload').textContent);const matrix=data.matrix.results.map(r=>({...r,layer:data.matrixLabel,title:r.id}));const historicalMatrix=data.historicalMatrix.results.map(r=>({...r,layer:'10/13 历史参数矩阵',title:r.id}));const verified=data.verification.runs.map(r=>({...r,layer:'GUI 产物独立核验',title:r.id}));const ui=data.ui.cases.map(r=>({...r,layer:'10/13 历史 GUI'}));const current=data.mergedGuiCases.map(r=>({...r,layer:'本轮原生 GUI',title:r.title||r.action||r.id}));const records=[...current,...verified,...matrix,...historicalMatrix,...ui];document.getElementById('notes').textContent=JSON.stringify({notes:data.currentGui.notes,defects:data.currentGui.defects},null,2);const list=document.getElementById('list');function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}function state(r){return ['pass','ok','passed','通过'].includes(r.status)?'pass':['fail','failed','失败'].includes(r.status)?'fail':'pending';}function render(){const q=document.getElementById('search').value.toLowerCase(),status=document.getElementById('status').value,layer=document.getElementById('layer').value;const selected=records.filter(r=>(!layer||r.layer===layer)&&(!status||state(r)===status)&&JSON.stringify(r).toLowerCase().includes(q));document.getElementById('count').textContent=`显示 ${selected.length} / ${records.length} 项记录`;list.innerHTML=selected.map(r=>`<article><details><summary><span class="${state(r)}">${state(r).toUpperCase()}</span> ${escapeHtml(r.id)} - ${escapeHtml(r.title||r.feature)} <small>${escapeHtml(r.layer)}</small></summary><pre>${escapeHtml(JSON.stringify(r,null,2))}</pre></details></article>`).join('');}document.getElementById('search').addEventListener('input',render);document.getElementById('status').addEventListener('change',render);document.getElementById('layer').addEventListener('change',render);render();
</script></html>"""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(template.replace("__PAYLOAD__", payload).replace("__MATRIX_LABEL__", html.escape(matrix_label)), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "output/pdf/ffmpeg-workbench-test-report.pdf")
    parser.add_argument("--with-html", action="store_true", help="Also write an offline searchable HTML companion")
    args = parser.parse_args()
    summary = build_pdf(args.output.resolve())
    if args.with_html:
        html_path = args.output.resolve().with_name("ffmpeg-workbench-test-details.html")
        build_html(html_path)
        summary["html"] = str(html_path)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
