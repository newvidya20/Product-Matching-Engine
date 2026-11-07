import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nlp  # noqa: E402
from structured import gstin_valid  # noqa: E402


class CorrectionTests(unittest.TestCase):
    def test_pan_confusable_fixed_only_when_valid(self):
        t, f = nlp.correct_ids("PAN: ABCDEl234F")
        self.assertEqual(t, "PAN: ABCDE1234F")
        self.assertEqual(f[0]["kind"], "pan")

    def test_ifsc(self):
        t, _ = nlp.correct_ids("IFSC SBINO012345")  # letter O where the mandatory zero belongs
        self.assertIn("SBIN0012345", t)
        t2, f2 = nlp.correct_ids("IFSC SBIN0O12345")  # already a legal IFSC: untouched
        self.assertEqual(f2, [])

    def test_gstin_needs_checksum(self):
        good = "27AADCN4114G1ZR"
        self.assertTrue(gstin_valid(good))
        bad_ocr = "27AADCN4I14G1ZR"  # I for 1
        t, f = nlp.correct_ids("GSTIN " + bad_ocr)
        self.assertIn(good, t)
        # a wrong GSTIN that cannot be fixed to a checksum-valid one stays untouched
        t2, f2 = nlp.correct_ids("GSTIN 27AADCN4114G1ZQ")
        self.assertEqual(f2, [])
        self.assertIn("27AADCN4114G1ZQ", t2)

    def test_amount_confusable(self):
        t, f = nlp.correct_ids("Total 1,23,4S6.78")
        self.assertEqual(t, "Total 1,23,456.78")

    def test_plain_words_and_digits_untouched(self):
        s = "Cash Credit 5.40 Account 123456789012 dated 08/12/2025"
        t, f = nlp.correct_ids(s)
        self.assertEqual(t, s)
        self.assertEqual(f, [])

    def test_word_fix_requires_low_confidence(self):
        self.assertEqual(nlp.correct_words("Total Lirnits", 70)[0], "Total Limits")
        self.assertEqual(nlp.correct_words("Total Lirnits", 95)[0], "Total Lirnits")

    def test_words_with_digits_never_touched(self):
        self.assertEqual(nlp.correct_words("Lirnits 1,23,456.78 B2B", 60)[0], "Limits 1,23,456.78 B2B")


class MiscTests(unittest.TestCase):
    def test_devanagari_normalisation(self):
        self.assertEqual(nlp.normalize_devanagari("भारतीय ं"), "भारतीयं")
        self.assertEqual(nlp.normalize_devanagari("कााा"), "का")

    def test_language(self):
        self.assertEqual(nlp.line_language("Cash Credit 5.40"), "eng")
        self.assertEqual(nlp.line_language("शाखा आहे आणि"), "mar")
        self.assertEqual(nlp.line_language("यह बैंक की शाखा है"), "hin")

    def test_classify(self):
        t, c, _ = nlp.classify("Statement of Account\nOpening Balance 1,000.00\nNarration Withdrawal Deposit Closing Balance")
        self.assertEqual(t, "bank_statement")
        self.assertGreater(c, 0.4)

    def test_scaled_amount(self):
        a = nlp.scaled_amounts("limit of Rs. 5.40 Cr and 12 Lakhs")
        self.assertEqual(a[0]["value_inr"], "54000000.00")
        self.assertEqual(a[1]["value_inr"], "1200000")

    def test_typed_extract(self):
        r = nlp.extract_typed("balance_sheet", {3: "Total Assets   12,34,567.00   11,00,000.00"})
        self.assertEqual(r["total_assets"]["normalized"], "1234567.00")
        self.assertEqual(r["total_assets"]["page"], 3)

    def test_clean_page_keeps_raw(self):
        raw = {"page": 1, "blocks": [{"text": "PAN ABCDEl234F", "bbox": [10, 100, 200, 120], "conf": 90, "engine": "t"}], "text": "PAN ABCDEl234F", "tables": []}
        import copy
        before = copy.deepcopy(raw)
        out = nlp.clean_page(raw, page_size=(600, 800))
        self.assertEqual(raw, before)
        self.assertIn("ABCDE1234F", out["text"])
        self.assertTrue(any(fl["field"] == "pan" for fl in out["flags"]))


if __name__ == "__main__":
    unittest.main()
