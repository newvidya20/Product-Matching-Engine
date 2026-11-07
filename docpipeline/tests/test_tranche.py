import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chunks  # noqa: E402
import escalate  # noqa: E402
import tranche  # noqa: E402


class ContinuityTests(unittest.TestCase):
    HDR = ["Date", "Narration", "Debit", "Credit", "Balance"]

    def test_running_balance_ok_across_page_boundary(self):
        t = {"pages": [1, 2], "rows": [self.HDR, ["01/01", "a", "", "1,000.00", "5,000.00"], ["02/01", "b", "200.00", "", "4,800.00"],
                                       ["03/01", "c", "", "50.00", "4,850.00"]], "row_pages": [1, 1, 1, 2]}
        r = tranche.running_balance_check(t)
        self.assertEqual(r["checked"], 2)
        self.assertEqual(r["breaks"], [])
        self.assertEqual(r["implied_opening"], "4000.00")

    def test_break_reported_with_boundary_flag(self):
        t = {"pages": [1, 2], "rows": [self.HDR, ["01/01", "a", "", "1,000.00", "5,000.00"], ["02/01", "b", "200.00", "", "4,800.00"],
                                       ["03/01", "c", "", "50.00", "9,999.00"]], "row_pages": [1, 1, 1, 2]}
        r = tranche.running_balance_check(t)
        self.assertEqual(r["n_breaks"], 1)
        self.assertTrue(r["breaks"][0]["at_page_boundary"])

    def test_statement_chain(self):
        files = [{"file": "feb", "account": "123456789", "opening": "100.00", "closing": "250.00", "period_start": "2026-02-01"},
                 {"file": "jan", "account": "123456789", "opening": "50.00", "closing": "100.00", "period_start": "2026-01-01"},
                 {"file": "mar", "account": "123456789", "opening": "999.00", "closing": "1.00", "period_start": "2026-03-01"}]
        res = tranche.statement_chain(files)
        self.assertEqual([(r["from"], r["to"], r["match"]) for r in res], [("jan", "feb", True), ("feb", "mar", False)])

    def test_sections_span_pages(self):
        cleans = {1: {"text": "SANCTION LETTER\nbody"}, 2: {"text": "more body"}, 3: {"text": "ANNEXURE A\nx"}}
        s = tranche.sections(cleans)
        self.assertEqual((s[0]["title"], s[0]["page_start"], s[0]["page_end"]), ("SANCTION LETTER", 1, 2))
        self.assertEqual(s[1]["title"], "ANNEXURE A")


class ChunkTests(unittest.TestCase):
    def _clean(self, text, p=1):
        return {p: {"text": text, "confidence": 95.0, "flags": [], "languages": {"eng": 1}}}

    def test_table_run_never_split(self):
        table = "\n".join(f"Item {i}   {i * 100}.00   {i * 7}.50" for i in range(60))
        prose = " ".join(["word"] * 1500)
        text = prose + "\n\n" + table + "\n\n" + prose
        cs = chunks.build_chunks("f.pdf", self._clean(text), "other", 0.0, [], [])
        holders = [c for c in cs if "Item 0 " in c["text"]]
        self.assertEqual(len(holders), 1)
        self.assertIn("Item 59 ", holders[0]["text"])

    def test_chunks_have_metadata(self):
        cs = chunks.build_chunks("f.pdf", self._clean("Total   1,000.00   2,000.00\nPAN ABCDE1234F"), "bank_statement", 0.8, [], [])
        self.assertEqual(cs[0]["doc_type"], "bank_statement")
        self.assertIn("pan", cs[0]["entities"])
        self.assertEqual(cs[0]["confidence"]["min"], 95.0)


class QualityTests(unittest.TestCase):
    def test_completeness(self):
        self.assertEqual(escalate.field_completeness("nothing here"), 1.0)
        self.assertEqual(escalate.field_completeness("GSTIN: 27AADCN4114G1ZR"), 1.0)
        self.assertEqual(escalate.field_completeness("GSTIN: 27AAD?N4114G1ZR"), 0.0)

    def test_garbage(self):
        self.assertGreater(escalate.garbage_ratio("§¶¤¥ªº"), 0.5)
        self.assertEqual(escalate.garbage_ratio("Cash Credit 5.40 भारतीय"), 0.0)

    def test_ladder_stops_when_good_and_escalates_when_bad(self):
        good = {"a": [{"text": "Cash Credit 5.40", "bbox": [0, 0, 100, 20], "conf": 97, "engine": "t"}]}
        calls = []
        r = escalate.run_ladder(good, 1, 50.0, {1: lambda: calls.append(1) or {}}, lambda ls: " ".join(l["text"] for l in ls))
        self.assertEqual((r["level"], calls), (0, []))
        bad = {"a": [{"text": "Cash Credit 5.40", "bbox": [0, 0, 100, 20], "conf": 40, "engine": "t"}]}
        better = {"b": [{"text": "Cash Credit 5.40", "bbox": [0, 0, 100, 20], "conf": 99, "engine": "t"}]}
        r = escalate.run_ladder(bad, 1, 101.0, {1: lambda: better, 2: lambda: {}}, lambda ls: " ".join(l["text"] for l in ls))
        self.assertEqual(r["level"], 2)
        self.assertEqual(r["lines"][0]["conf"], 99)


if __name__ == "__main__":
    unittest.main()
