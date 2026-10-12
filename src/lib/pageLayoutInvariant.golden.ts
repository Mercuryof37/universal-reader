/**
 * ⚠️ **自动生成，不要手改。** 生成命令见本文件末尾。
 *
 * `GOLDEN_BLOCKS_JSON` 与 `GOLDEN_STRUCTURE_JSON` 是**改动前那一版**
 * （`git show HEAD:src/lib/ocrStructure.ts` 与 `…/ocrPostProcess.ts`）
 * 对下面这份 `FIXTURE_WORDS` 跑出来的**真实输出**，逐字节抄录。
 *
 * 为什么必须这样生成：手写一个「我认为改动前应该输出什么」的对象，
 * 只能证明「今天的代码符合我今天的预期」，证明不了「与接入前逐字节相同」。
 * 而后者是本次改动唯一的不变量（见 `pageLayoutInvariant.test.ts`）。
 *
 * ⚠️ **T5 之后它怎么用**（`GOLDEN_STRUCTURE_JSON` 本身**不改**，一个字节都不改）：
 * 导出从 T5 起带六个信封字段（`schema` / `schemaVersion` / `producer` /
 * `document` / `contract` / `compatibility`），所以「整份导出 = 这个字符串」
 * 已不可能成立。不变量因此换成**判定部分**逐字节相同：
 * 这里扣掉旧信封（`kind` / `version` / `buildId`）剩下的字节
 * （见 `ocrStructureContract.golden.ts` 的 `LEGACY_DECISION_JSON`）
 * 必须等于新导出扣掉新信封之后的字节。
 * `GOLDEN_STRUCTURE_JSON` 因此是那份不变量的**唯一原始来源**，谁都不许改它。
 *
 * 重新生成：
 *   cd universal-reader
 *   node ../scripts-out/gen-golden.mjs src/lib/pageLayoutInvariant.golden.ts
 * （只读 `git show`，无任何 git 写操作）
 */
import type { OcrWord } from '@/lib/ocrTypes';

export const FIXTURE_WORDS: OcrWord[] = [
  {
    "text": "概率论与数理统计习题5",
    "confidence": 93,
    "bbox": {
      "x0": 320,
      "y0": 24,
      "x1": 680,
      "y1": 62
    },
    "fontSize": 20
  },
  {
    "text": "设随机变量",
    "confidence": 95,
    "bbox": {
      "x0": 120,
      "y0": 200,
      "x1": 300,
      "y1": 240
    },
    "fontSize": 26
  },
  {
    "text": "X",
    "confidence": 96,
    "bbox": {
      "x0": 312,
      "y0": 202,
      "x1": 336,
      "y1": 240
    },
    "fontSize": 26
  },
  {
    "text": "的分布函数为",
    "confidence": 92,
    "bbox": {
      "x0": 348,
      "y0": 200,
      "x1": 588,
      "y1": 240
    },
    "fontSize": 26
  },
  {
    "text": "2",
    "confidence": 88,
    "bbox": {
      "x0": 598,
      "y0": 196,
      "x1": 610,
      "y1": 216
    },
    "fontSize": 14
  },
  {
    "text": "，则",
    "confidence": 90,
    "bbox": {
      "x0": 620,
      "y0": 200,
      "x1": 672,
      "y1": 240
    },
    "fontSize": 26
  },
  {
    "text": "求",
    "confidence": 94,
    "bbox": {
      "x0": 120,
      "y0": 260,
      "x1": 146,
      "y1": 300
    },
    "fontSize": 26
  },
  {
    "text": "P",
    "confidence": 91,
    "bbox": {
      "x0": 158,
      "y0": 262,
      "x1": 182,
      "y1": 300
    },
    "fontSize": 26
  },
  {
    "text": "的值。",
    "confidence": 93,
    "bbox": {
      "x0": 194,
      "y0": 260,
      "x1": 298,
      "y1": 300
    },
    "fontSize": 26
  },
  {
    "text": "设",
    "confidence": 94,
    "bbox": {
      "x0": 120,
      "y0": 420,
      "x1": 146,
      "y1": 460
    },
    "fontSize": 26
  },
  {
    "text": "e",
    "confidence": 92,
    "bbox": {
      "x0": 158,
      "y0": 420,
      "x1": 200,
      "y1": 460
    },
    "fontSize": 26
  },
  {
    "text": "-(x+y)",
    "confidence": 90,
    "bbox": {
      "x0": 200,
      "y0": 396,
      "x1": 296,
      "y1": 420
    },
    "fontSize": 16
  },
  {
    "text": "为正值。",
    "confidence": 93,
    "bbox": {
      "x0": 296,
      "y0": 420,
      "x1": 452,
      "y1": 460
    },
    "fontSize": 26
  },
  {
    "text": "单周周一下午2点前交作业",
    "confidence": 89,
    "bbox": {
      "x0": 300,
      "y0": 1330,
      "x1": 700,
      "y1": 1362
    },
    "fontSize": 18
  }
];

/** 改动前 `ocrResultToBlocks(page, 1400)` 的真实输出（不传版面信息） */
export const GOLDEN_BLOCKS_JSON = "[{\"type\":\"paragraph\",\"content\":\"2 设随机变量X 的分布函数为，则\",\"translations\":{},\"metadata\":{\"pageNumber\":1,\"ocrConfidence\":92}},{\"type\":\"paragraph\",\"content\":\"求P 的值。\",\"translations\":{},\"metadata\":{\"pageNumber\":1,\"ocrConfidence\":93}},{\"type\":\"paragraph\",\"content\":\"设e$^{-(x+y)}$为正值。\",\"translations\":{},\"metadata\":{\"pageNumber\":1,\"ocrConfidence\":92,\"hasInlineMath\":true}}]";

/** 改动前 `buildOcrStructure(...)` 经 `onPageStructure` 拿到的真实输出 */
export const GOLDEN_STRUCTURE_JSON = "{\"kind\":\"universal-reader/ocr-structure\",\"version\":1,\"buildId\":\"test-build\",\"pageNum\":1,\"canvasHeight\":1400,\"dominantFontSize\":23.6,\"thresholds\":{\"scriptMaxFontRatio\":0.9,\"scriptSuperShift\":0.25,\"scriptSubShift\":0.18,\"scriptFragmentGap\":0.6,\"scriptSuperBand\":1.5,\"scriptSubBand\":1.2,\"sameLineTolerance\":5,\"baselineMinDriftRatio\":1,\"baselineMaxResidualRatio\":0.35,\"tiltJoinGapRatio\":1.5},\"words\":[{\"i\":0,\"text\":\"概率论与数理统计习题5\",\"confidence\":93,\"bbox\":[320,24,680,62],\"fontSize\":20,\"height\":38,\"centerY\":43},{\"i\":1,\"text\":\"设随机变量\",\"confidence\":95,\"bbox\":[120,200,300,240],\"fontSize\":26,\"height\":40,\"centerY\":220},{\"i\":2,\"text\":\"X\",\"confidence\":96,\"bbox\":[312,202,336,240],\"fontSize\":26,\"height\":38,\"centerY\":221},{\"i\":3,\"text\":\"的分布函数为\",\"confidence\":92,\"bbox\":[348,200,588,240],\"fontSize\":26,\"height\":40,\"centerY\":220},{\"i\":4,\"text\":\"2\",\"confidence\":88,\"bbox\":[598,196,610,216],\"fontSize\":14,\"height\":20,\"centerY\":206},{\"i\":5,\"text\":\"，则\",\"confidence\":90,\"bbox\":[620,200,672,240],\"fontSize\":26,\"height\":40,\"centerY\":220},{\"i\":6,\"text\":\"求\",\"confidence\":94,\"bbox\":[120,260,146,300],\"fontSize\":26,\"height\":40,\"centerY\":280},{\"i\":7,\"text\":\"P\",\"confidence\":91,\"bbox\":[158,262,182,300],\"fontSize\":26,\"height\":38,\"centerY\":281},{\"i\":8,\"text\":\"的值。\",\"confidence\":93,\"bbox\":[194,260,298,300],\"fontSize\":26,\"height\":40,\"centerY\":280},{\"i\":9,\"text\":\"设\",\"confidence\":94,\"bbox\":[120,420,146,460],\"fontSize\":26,\"height\":40,\"centerY\":440},{\"i\":10,\"text\":\"e\",\"confidence\":92,\"bbox\":[158,420,200,460],\"fontSize\":26,\"height\":40,\"centerY\":440},{\"i\":11,\"text\":\"-(x+y)\",\"confidence\":90,\"bbox\":[200,396,296,420],\"fontSize\":16,\"height\":24,\"centerY\":408},{\"i\":12,\"text\":\"为正值。\",\"confidence\":93,\"bbox\":[296,420,452,460],\"fontSize\":26,\"height\":40,\"centerY\":440},{\"i\":13,\"text\":\"单周周一下午2点前交作业\",\"confidence\":89,\"bbox\":[300,1330,700,1362],\"fontSize\":18,\"height\":32,\"centerY\":1346}],\"wordsTotal\":14,\"wordsWithChars\":0,\"charBoxSkips\":[],\"lines\":[{\"text\":\"2 设随机变量X 的分布函数为，则\",\"y\":196,\"fontSize\":23.6,\"avgConfidence\":92.2,\"yRange\":[196,240],\"xRange\":[120,672],\"wordIndices\":[4,1,2,3,5],\"hasScripts\":false,\"stats\":[{\"i\":4,\"text\":\"2\",\"height\":20,\"centerShift\":-14,\"baselineShift\":-24,\"heightRatio\":0.5,\"gapToHigherLeft\":10}]},{\"text\":\"求P 的值。\",\"y\":280,\"fontSize\":26,\"avgConfidence\":92.7,\"yRange\":[260,300],\"xRange\":[120,298],\"wordIndices\":[6,7,8],\"hasScripts\":false,\"stats\":[]},{\"text\":\"设e$^{-(x+y)}$为正值。\",\"y\":440,\"fontSize\":23.5,\"avgConfidence\":92.3,\"yRange\":[396,460],\"xRange\":[120,452],\"wordIndices\":[9,10,11,12],\"hasScripts\":true,\"stats\":[{\"i\":11,\"text\":\"-(x+y)\",\"height\":24,\"centerShift\":-32,\"baselineShift\":-40,\"heightRatio\":0.6,\"gapToHigherLeft\":0}]}],\"linesTotal\":3,\"blocks\":[{\"type\":\"paragraph\",\"content\":\"2 设随机变量X 的分布函数为，则\",\"hasInlineMath\":false},{\"type\":\"paragraph\",\"content\":\"求P 的值。\",\"hasInlineMath\":false},{\"type\":\"paragraph\",\"content\":\"设e$^{-(x+y)}$为正值。\",\"hasInlineMath\":true}],\"truncated\":{\"wordsDropped\":0,\"linesDropped\":0,\"charBudget\":160000}}";
