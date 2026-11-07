import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import merge  # noqa: E402


def L(text, box, conf, engine="x"):
    return {"text": text, "bbox": box, "conf": conf, "engine": engine}


class DedupeTests(unittest.TestCase):
    def test_reported_bug(self):
        self.assertEqual(merge.dedupe_line("Total of Fund Based Limits  Based Limits  6.15  7.38"),
                         "Total of Fund Based Limits  6.15  7.38")

    def test_adjacent_ngram(self):
        self.assertEqual(merge.dedupe_line("Fund Based Limits Based Limits"), "Fund Based Limits")
        self.assertEqual(merge.dedupe_line("the the current assets"), "the current assets")
        self.assertEqual(merge.dedupe_line("Cash Credit Cash Credit limit"), "Cash Credit limit")

    def test_numeric_repeats_kept(self):
        for s in ("5.40  5.40", "0.00 0.00", "(5.40)  (5.40)", "Total 1,23,456.78 1,23,456.78"):
            self.assertEqual(merge.dedupe_line(s), s)

    def test_digits_never_change(self):
        for s in ("Total Limits  Limits 6.15  7.38", "Rs. 5,40,000.00 Rs. 5,40,000.00 Cash Cash", "A/c 123456789012 A/c 123456789012",
                  "Limit Limit 0.00 0.00 0.00"):
            self.assertEqual(merge.digits_of(merge.dedupe_line(s)), merge.digits_of(s), s)

    def test_distinct_column_headers_kept(self):
        s = "EXISTING LIMIT  PROPOSED LIMIT"
        self.assertEqual(merge.dedupe_line(s), s)


class MergeTests(unittest.TestCase):
    def test_one_winner_no_concatenation(self):
        a = [L("Total of Fund Based Limits", [10, 10, 300, 30], 97, "paddle")]
        b = [L("Total of Fund Based Limits", [10, 11, 240, 31], 90, "tess"), L("Based Limits", [180, 10, 300, 30], 80, "tess")]
        out = merge.merge_regions({"paddle": a, "tess": b})
        text = " ".join(l["text"] for l in out)
        self.assertEqual(text.count("Based"), 1)
        self.assertEqual(text, "Total of Fund Based Limits")

    def test_best_engine_per_region(self):
        a = [L("Cash Credit  5.40", [10, 10, 300, 30], 99, "paddle"), L("EPC 0.75", [10, 100, 300, 120], 60, "paddle")]
        b = [L("Cash Credit  5.40", [10, 11, 300, 31], 80, "tess"), L("EPC 0.75", [10, 100, 300, 121], 95, "tess")]
        out = {l["engine"]: l["text"] for l in merge.merge_regions({"p": a, "t": b})}
        self.assertEqual(out, {"paddle": "Cash Credit  5.40", "tess": "EPC 0.75"})

    def test_unmatched_lines_kept(self):
        a = [L("Only paddle sees this", [0, 0, 100, 20], 90, "paddle")]
        b = [L("Only tess sees this", [0, 200, 100, 220], 90, "tess")]
        self.assertEqual(len(merge.merge_regions({"p": a, "t": b})), 2)

    def test_split_cells_vs_whole_row(self):
        cells = [L("Cash Credit", [10, 10, 120, 30], 95, "paddle"), L("5.40", [200, 10, 250, 30], 95, "paddle"), L("5.40", [300, 10, 350, 30], 95, "paddle")]
        row = [L("Cash Credit  5.40  5.40", [10, 10, 350, 30], 85, "tess")]
        out = merge.merge_regions({"p": cells, "t": row})
        self.assertEqual(sorted(l["text"] for l in out), ["5.40", "5.40", "Cash Credit"])

    def test_digits_untouched_by_merge(self):
        a = [L("Amount 1,23,456.78", [0, 0, 200, 20], 90, "paddle")]
        b = [L("Amount 1,23,456.78", [0, 1, 200, 21], 95, "tess")]
        out = merge.merge_regions({"p": a, "t": b})
        self.assertEqual(merge.digits_of(out[0]["text"]), "12345678")


if __name__ == "__main__":
    unittest.main()
