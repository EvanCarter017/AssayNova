import importlib.util
import io
import os
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from PIL import Image

SPEC = importlib.util.spec_from_file_location('import_parser', Path(__file__).parents[1] / 'conference' / 'import_parser.py')
PARSER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARSER)
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
SOURCE = Path(r'C:\Users\Administrator\Desktop\话术\产品报价_售价与原价(1)(1).xlsx')


def workbook(sheet, extra=None):
    members = {
        'xl/workbook.xml': f'<workbook xmlns="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Products" sheetId="1" r:id="r1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{NS}">{sheet}</worksheet>'
    }
    members.update(extra or {})
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in members.items():
            archive.writestr(name, value)
    return result.getvalue()


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def table(self, content, fmt='csv', **options):
        source = self.root / 'input.raw'
        source.write_bytes(content)
        return PARSER.table({'action': 'table', 'input': str(source), 'format': fmt, 'columns': {'sku': 'A', 'product': 'B'}, **options})

    def test_csv_tsv_column_mapping_preserves_text_and_ignores_other_columns(self):
        result = self.table(b'Internal title\n\nProductName,Price,ShortCode\n"Adamax 10mg",9999,00017\n', headerRow=3, columns={'sku': 'C', 'product': 'A'})
        self.assertEqual(result['rows'], [{'row': 4, 'sku': '00017', 'product': 'Adamax 10mg', 'error': ''}])
        self.assertNotIn('9999', str(result))
        result = self.table('\ufeffShort\tName\tSpec\nADA10\tAdamax\t10mg*10vials\n'.encode(), 'tsv', columns={'sku': 'A', 'product': 'B', 'dose': 'C'})
        self.assertEqual(result['rows'][0]['dose'], '10mg*10vials')
        with self.assertRaises(PARSER.ImportProblem):
            self.table(b'SKU,Price\nA,99\n')

    def test_xlsx_shared_rich_inline_sparse_strings_zero_format_and_real_merges(self):
        sheet = '<sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>SKU</t></is></c><c r="C3" t="inlineStr"><is><t>Product</t></is></c></row><row r="4"><c r="A4" s="0"><v>7</v></c><c r="C4" t="s"><v>0</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>ADX10</t></is></c></row><row r="6"><c r="A6" t="inlineStr"><is><t>UNKNOWN</t></is></c></row></sheetData><mergeCells><mergeCell ref="C4:C5"/></mergeCells>'
        extra = {'xl/sharedStrings.xml': f'<sst xmlns="{NS}"><si><r><t>Adamax </t></r><r><t>10mg</t></r></si></sst>', 'xl/styles.xml': f'<styleSheet xmlns="{NS}"><numFmts><numFmt numFmtId="164" formatCode="00000"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>'}
        result = self.table(workbook(sheet, extra), 'xlsx', headerRow=3, columns={'sku': 'A', 'product': 'C'})
        self.assertEqual(result['rows'][0]['sku'], '00007')
        self.assertEqual(result['rows'][1]['product'], 'Adamax 10mg')
        self.assertEqual(result['rows'][2]['product'], '')
        self.assertIn('Missing', result['rows'][2]['error'])
        self.assertEqual(result['verticalMergeCount'], 1)

    def test_formulas_and_ambiguous_merges_are_row_errors_not_executed(self):
        result = self.table(b'SKU,Product\n=1+1,Adamax 10mg\n')
        self.assertIn('Formula', result['rows'][0]['error'])
        sheet = '<sheetData><row><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Product</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>ADA10</t></is></c><c r="B2" t="inlineStr"><is><t>Adamax 10mg</t></is></c></row></sheetData><mergeCells><mergeCell ref="A2:B2"/></mergeCells>'
        self.assertIn('Ambiguous', self.table(workbook(sheet), 'xlsx')['rows'][0]['error'])

    def test_rejects_unsafe_zip_dtd_external_macro_and_dimension_bounds(self):
        for extra in [
            {'../escape.xml': '<x/>'}, {'xl/./escape.xml': '<x/>'}, {'xl//escape.xml': '<x/>'},
            {'xl/externalLinks/externalLink1.xml': '<x/>'}, {'xl/vbaProject.bin': b'unsafe'},
            {'xl/extra.xml': '<!DOCTYPE x [<!ENTITY y "unsafe">]><x>&y;</x>'},
            {'xl/extra.rels': '<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>'}
        ]:
            with self.subTest(members=list(extra)), self.assertRaises(PARSER.ImportProblem):
                self.table(workbook('<sheetData/>', extra), 'xlsx')
        for dimension in ['A1:BM2', 'A1:A10001']:
            with self.assertRaises(PARSER.ImportProblem):
                self.table(workbook(f'<dimension ref="{dimension}"/><sheetData/>'), 'xlsx')
        with self.assertRaises(PARSER.ImportProblem):
            self.table(b'not a ZIP', 'xlsx')
        with self.assertRaises(PARSER.ImportProblem):
            self.table(('SKU,Product\nA,' + 'x' * 2049).encode())
        with self.assertRaises(PARSER.ImportProblem):
            self.table(('SKU,Product\n' * 10001).encode())

    def test_rejects_duplicate_members_and_expansion_bounds(self):
        source = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            with zipfile.ZipFile(source, 'w') as archive:
                archive.writestr('same.xml', '<x/>')
                archive.writestr('same.xml', '<x/>')
        with self.assertRaises(PARSER.ImportProblem):
            self.table(source.getvalue(), 'xlsx')
        with self.assertRaises(PARSER.ImportProblem):
            self.table(workbook('<sheetData/>', {'large.xml': 'x' * (4 * 1024 * 1024 + 1)}), 'xlsx')
        entity = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY y "EXPANDED">]><x>&y;</x>'
        for encoding in ['utf-16', 'utf-16-le', 'utf-32', 'utf-32-be']:
            with self.subTest(encoding=encoding), self.assertRaises(PARSER.ImportProblem):
                self.table(workbook('<sheetData/>', {'xl/encoded.xml': entity.encode(encoding)}), 'xlsx')

    def test_images_decode_by_signature_keep_pixels_and_reject_spoofs_and_dimensions(self):
        image = Image.new('RGBA', (12, 9), (32, 80, 120, 170))
        original = self.root / 'source.raw'; image.save(original, format='PNG')
        output = self.root / 'normalized'
        request = {'files': [{'id': 'a' * 32, 'input': str(original), 'name': 'folder/ADA10.png'}], 'outputDirectory': str(output)}
        result = PARSER.images(request)
        with Image.open(output / result['images'][0]['file']) as decoded:
            self.assertEqual(decoded.tobytes(), image.tobytes())
            self.assertEqual(decoded.size, image.size)
        self.assertEqual((output / result['images'][0]['file']).read_bytes(), original.read_bytes())
        deep = Image.new('I;16', (3, 2)); deep.putpixel((1, 1), 40000); deep.save(original, format='PNG')
        preserved = PARSER.images(request)
        with Image.open(output / preserved['images'][0]['file']) as decoded:
            self.assertEqual(decoded.getpixel((1, 1)), 40000)
        self.assertEqual((output / preserved['images'][0]['file']).read_bytes(), original.read_bytes())
        request['files'][0]['name'] = 'ADA10.jpg'
        with self.assertRaises(PARSER.ImportProblem):
            PARSER.images(request)
        request['files'][0]['name'] = 'ADA10.png'
        original.write_bytes(b'not an image')
        with self.assertRaises(PARSER.ImportProblem):
            PARSER.images(request)
        large = Image.new('1', (5000, 4001)); large.save(original, format='PNG')
        with self.assertRaises(PARSER.ImportProblem):
            PARSER.images(request)

    @unittest.skipUnless(os.environ.get('ASSAYNOVA_CATALOG_QA') == '1' and SOURCE.is_file(), 'explicit real source QA only')
    def test_original_quote_is_read_only_202_identity_rows_58_vertical_merges_no_prices(self):
        before = SOURCE.read_bytes()
        result = PARSER.table({'action': 'table', 'input': str(SOURCE), 'format': 'xlsx', 'headerRow': 2, 'columns': {'sku': 'A', 'product': 'B', 'dose': 'C'}})
        self.assertEqual(len(result['rows']), 202)
        self.assertEqual(result['verticalMergeCount'], 58)
        self.assertEqual(result['mergeCount'], 59)
        self.assertTrue(all(set(row) <= {'row', 'sku', 'product', 'dose', 'error'} for row in result['rows']))
        self.assertFalse(any(row['error'] for row in result['rows']))
        self.assertEqual(SOURCE.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
