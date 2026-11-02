import datetime as dt

from receiptflow import parse


def test_aade_signature_url():
    f = parse.parse_qr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DMW25009721000085977D569F78468776A75B03E328C34461261013142850.00")
    assert (f.date, f.time, f.amount) == (dt.date(2026, 10, 13), "14:28", 50.0)


def test_aade_signature_small_amount():
    f = parse.parse_qr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DMW250097210000859032591D5B82B946E07C5F5B8BFB35DC26101313015.50")
    assert (f.date, f.amount) == (dt.date(2026, 10, 13), 5.5)


def test_semicolon_qr():
    f = parse.parse_qr("2;0016831;0438144490643;2026-10-20;17:36:20;A;1350370;A;1;10;2;2,129;9,39;20,00;1118469")
    assert (f.date, f.time, f.amount) == (dt.date(2026, 10, 20), "17:36", 20.0)


def test_qr_without_data():
    assert parse.parse_qr("https://example.com/pay?id=abc") is None


OCR_SAMPLE = """TIMH ALTPOY 2,129
ΣΥΝΟΛΟ ΛΙΤΡΩΝ 9,390
ΚΑΘΑΡΗ ΑΞΙΑ 16,13€
Φ.Π.Α. 24, 00% — 3,87€
XYNOAO ME ΦΠΑ 20 ,00€
HM/NIA: 20/10/2026 17:36
"""


def test_ocr_total_date_time():
    f = parse.parse_ocr(OCR_SAMPLE)
    assert (f.date, f.time, f.amount) == (dt.date(2026, 10, 20), "17:36", 20.0)


def test_ocr_net_plus_vat_when_total_unreadable():
    f = parse.parse_ocr("ΚΑΘΑΡΗ ΑΞΙΑ 40,32€\nΦ.Π.Α. 24,00% 9,68€\nΣΥΝΟΛΟ ΜΕ ΦΠΑ ~~~\nΗΜ/ΝΙΑ:13/10/2026 14:28")
    assert f.amount == 50.0 and f.date == dt.date(2026, 10, 13)


def test_categories():
    assert parse.guess_category("UNLEADED 95\nΤΙΜΗ ΛΙΤΡΟΥ") == "fuel"
    assert parse.guess_category("ΑΤΤΙΚΗ ΟΔΟΣ Α.Ε. ΔΙΟΔΙΑ") == "tolls"
    assert parse.guess_category("TAXI 1234") == "taxi"
    assert parse.guess_category("ΚΑΤΙ ΑΛΛΟ") == "other"


def test_handwriting_is_not_a_receipt():
    assert not parse.looks_like_receipt("J. DOE\n10/2026")
    assert parse.looks_like_receipt("ΑΠΟΔΕΙΞΗ ΕΣΟΔΟΥ\nΣΥΝΟΛΟ ΜΕ ΦΠΑ 20,00")


SEP_FUEL_OCR = """UNL CRYSTAL NEXT --
| TIMH AITPOY ΄. Coe Pe, 1,730
> ZYNOAO AITPON Mee ο 34,690
{ ΚΑΘΑΡΗ ΑΞΙΑ | we 43,40€
\\ Φ.Π.Α. 24,008 ο τς 11, 61€ |
ΑΣ ΣΥΝΟΝΟ ΝΕ OMA στ 5 60,018
HM/NIA: 02/09/2025 12:44 1: -
"""


def test_ocr_noisy_fuel_total():
    # "60,018" is 60,01€ with the euro sign read as 8; litres x price confirms it
    f = parse.parse_ocr(SEP_FUEL_OCR)
    assert (f.date, f.time, f.amount) == (dt.date(2025, 9, 2), "12:44", 60.01)


def test_taximeter_sig_without_date():
    f = parse.parse_qr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=GL125000170000007300A5343330DD4A96948A58351A0BFE3D04B383D0D00010.52")
    assert f.date is None and f.amount == 10.52


def test_taxi_category():
    assert parse.guess_category("ΤΑΡΙΦΑ 1 ΧΛΜ ΚΟΣΤΟΣ\nΣΗΜΑΙΑ 1.80") == "taxi"


def test_sig_layout_without_timestamp():
    # Shell, March 2024: 40-char hash, no date-time, total 11.99 (old guess gave 9811.99)
    f = parse.parse_qr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DLD200171390088437748B72ED35F2301678FDB32892B4FE7495D021B9811.99")
    assert f.amount == 11.99 and f.date is None and not f.candidates


def test_sig_layout_comma_total():
    f = parse.parse_qr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=CCC1800337600577775522E747A6A6A931409188575C073385A76FCD8A813,44")
    assert f.amount == 13.44


def test_sig_layout_with_timestamp():
    f = parse.parse_qr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DMK2400468000218726EA86D8163BCEC7F4994F268432F440260602223710.00")
    assert (f.date, f.time, f.amount) == (dt.date(2026, 6, 2), "22:37", 10.0)


def test_vat_rate_after_amount_is_not_money():
    # taximeter lines "€ 5.65-13.00%" read by OCR as "€ 565-13. 88": no total here, and 13.88 must not appear
    f = parse.parse_ocr("ΤΗΛ.ΡΑΝΤΕΒ\n€ 565-13. 88\nΣ.ΠΡΟΣ/ΤΩΝ :\n€5.65-13.08¢\n")
    assert f.amount != 13.88 and f.amount != 13.08


def test_payable_on_the_line_below():
    f = parse.parse_ocr("ΣΥΝΟΛΙΚΗ ΧΡΕΩΣΗ: 9,35\nΠΛΗΡΩΤΕΟ :\n€ 22,60\nΗΜ/ΝΙΑ: 03/09/2025 12:19")
    assert (f.amount, f.date) == (22.6, dt.date(2025, 9, 3))


def test_guess_is_flagged():
    f = parse.parse_ocr("ΚΑΤΙ € 5,65\nΑΛΛΟ € 1,80")
    assert f.amount == 5.65 and f.guessed


def test_rate_with_lost_decimal_point():
    f = parse.parse_ocr("τς € 565-13. 88\nτος ε.88:19.88/\n")
    assert f.amount not in (13.88, 19.88)


def test_dates_with_dashes_and_dots():
    assert parse.parse_ocr("ΕΝΑΡΞΗ ΔΙΑΔΡΟΜΗΣ:\nΗΜ/ΝΙΑ: 30-05-2023 11:24\nΠΛΗΡΩΤΕΟ: 15,67").date == dt.date(2023, 5, 30)
    assert parse.parse_ocr("ΗΜΕΡΟΜΗΝΙΑ 30.05.2023\nΣΥΝΟΛΟ 15,67").date == dt.date(2023, 5, 30)
    assert parse.parse_qr("x;30-05-2023;11:24;15,67").date == dt.date(2023, 5, 30)
    assert parse.parse_qr("x;30.05.2023;15,67").date == dt.date(2023, 5, 30)
    assert parse.parse_qr("x;2023-05-30;15,67").date == dt.date(2023, 5, 30)


def test_date_under_trip_start_label():
    text = ("ΑΔΕΙΑ ΚΥΚΛΟΦΟΡΙΑΣ 12/01/2019\n"          # an older, unlabelled date printed above
            "ΕΝΑΡΞΗ ΔΙΑΔΡΟΜΗΣ:\n03/09/2025 11:54 ΘΘ\n"
            "ΛΗΞΗ ΔΙΑΔΡΟΜΗΣ:\n03/09/2025 12:19 ΘΘ\nΠΛΗΡΩΤΕΟ :\n€ 22,60")
    f = parse.parse_ocr(text)
    assert (f.date, f.time, f.amount) == (dt.date(2025, 9, 3), "11:54", 22.6)


def test_trip_end_beats_unlabelled():
    f = parse.parse_ocr("ΑΔΕΙΑ 12/01/2019\nΛΗΞΗ ΔΙΑΔΡΟΜΗΣ:\n03/09/2025 12:19\n")
    assert (f.date, f.time) == (dt.date(2025, 9, 3), "12:19")


def test_trip_start_same_line():
    f = parse.parse_ocr("ΕΝΑΡΞΗ: 24/09/2025 11:07\nΛΗΞΗ: 24/09/2025 11:19\n")
    assert (f.date, f.time) == (dt.date(2025, 9, 24), "11:07")
