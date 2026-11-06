"""Bounded, read-only spreadsheet interpretation and lossless image decoding.

The HTTP layer supplies only server-generated paths. Nothing is extracted from
ZIP archives; only explicitly mapped identity columns leave the parser.
"""
import argparse
import csv
import hashlib
import io
import json
import re
import warnings
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

MAX_FILE = 8 * 1024 * 1024
MAX_XML = 4 * 1024 * 1024
MAX_ROWS, MAX_COLS, MAX_CELLS, MAX_TEXT = 10000, 64, 100000, 2048
MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


class ImportProblem(ValueError):
    pass


def bounded_file(filename, limit):
    with open(filename, 'rb') as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ImportProblem('Import file exceeds its size limit.')
    return data


def column(value):
    if not isinstance(value, str) or not re.fullmatch('[A-Z]{1,2}', value):
        raise ImportProblem('Choose a valid column.')
    result = 0
    for char in value:
        result = result * 26 + ord(char) - 64
    if result > MAX_COLS:
        raise ImportProblem('Column limit exceeded.')
    return result


def column_name(value):
    result = ''
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def cell_ref(value):
    match = re.fullmatch(r'([A-Z]{1,2})([1-9]\d*)', value or '')
    if not match or int(match[2]) > MAX_ROWS:
        raise ImportProblem('Worksheet dimensions exceed their limits.')
    return int(match[2]), column(match[1])


def text(value):
    value = str(value)
    if len(value) > MAX_TEXT:
        raise ImportProblem('A cell exceeds 2048 characters.')
    return value


def rich_text(node):
    def walk(element):
        if element.tag == MAIN + 'rPh':
            return ''
        if element.tag == MAIN + 't':
            return element.text or ''
        return ''.join(walk(child) for child in element)
    return text(walk(node))


def read_xlsx(data):
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError):
        raise ImportProblem('The XLSX archive is invalid.') from None
    with archive:
        entries = archive.infolist()
        if len(entries) > 128 or sum(item.file_size for item in entries) > 16 * 1024 * 1024:
            raise ImportProblem('The workbook archive exceeds its limits.')
        names, xml = set(), {}
        for item in entries:
            name = item.filename
            parts = name.rstrip('/').split('/')
            if name in names or not name or name.startswith('/') or '\\' in name or re.search(r'[\x00-\x1f\x7f:]', name) or any(part in ('', '.', '..') for part in parts) or item.flag_bits & 1 or item.compress_type not in (0, 8) or item.file_size > MAX_XML:
                raise ImportProblem('Unsafe or oversized workbook archive member.')
            names.add(name)
            if 'externallinks' in name.lower() or name.lower().endswith('.bin') or 'vba' in name.lower():
                raise ImportProblem('Macros and external workbook parts are not supported.')
            payload = archive.read(item)
            if len(payload) > MAX_XML:
                raise ImportProblem('Workbook member exceeds its size limit.')
            if name.endswith(('.xml', '.rels')):
                try:
                    decoded = payload.decode('utf-8-sig')
                except UnicodeDecodeError:
                    raise ImportProblem('Workbook XML parts must use UTF-8.') from None
                encoding = re.search(r'^\s*<\?xml[^>]*encoding\s*=\s*[\'"]([^\'"]+)', decoded, re.I)
                if '\x00' in decoded or (encoding and encoding[1].lower() not in ('utf-8', 'utf8', 'us-ascii')):
                    raise ImportProblem('Workbook XML parts must use UTF-8.')
                if re.search(r'<!\s*(?:DOCTYPE|ENTITY)', decoded, re.I):
                    raise ImportProblem('DTD and entity declarations are not supported.')
                try:
                    xml[name] = ET.fromstring(decoded)
                except ET.ParseError:
                    raise ImportProblem('Workbook XML is invalid.') from None
                if b'macroenabled' in payload.lower():
                    raise ImportProblem('Macro workbooks are not supported.')
                if name.endswith('.rels'):
                    for relation in xml[name]:
                        if relation.get('TargetMode', '').lower() == 'external' or re.match(r'^[a-z]+:', relation.get('Target', ''), re.I):
                            raise ImportProblem('External workbook relationships are not supported.')
        workbook = xml.get('xl/workbook.xml')
        relations = xml.get('xl/_rels/workbook.xml.rels')
        if workbook is None or relations is None:
            raise ImportProblem('Workbook metadata is missing.')
        targets = {}
        for relation in relations:
            target = relation.get('Target', '')
            member = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            if '..' in PurePosixPath(member).parts or '\\' in member or member not in xml:
                raise ImportProblem('Worksheet relationship is invalid.')
            targets[relation.get('Id')] = member
        shared = [rich_text(item) for item in xml.get('xl/sharedStrings.xml', [])]
        if len(shared) > MAX_CELLS:
            raise ImportProblem('Shared string limit exceeded.')
        formats = {}
        styles = xml.get('xl/styles.xml')
        if styles is not None:
            definitions = {item.get('numFmtId'): item.get('formatCode', '') for item in styles.iter(MAIN + 'numFmt')}
            xfs = styles.find(MAIN + 'cellXfs')
            if xfs is not None:
                for index, item in enumerate(xfs):
                    code = definitions.get(item.get('numFmtId'), '')
                    if re.fullmatch('0{1,32}', code):
                        formats[str(index)] = len(code)
        sheet_nodes = workbook.find(MAIN + 'sheets')
        if sheet_nodes is None or not 1 <= len(sheet_nodes) <= 16:
            raise ImportProblem('Choose a workbook with 1 to 16 sheets.')
        sheets, total_cells = [], 0
        for sheet in sheet_nodes:
            member = targets.get(sheet.get(REL + 'id'))
            if not member or not member.startswith('xl/worksheets/'):
                raise ImportProblem('Worksheet relationship is invalid.')
            root = xml[member]
            dimension = root.find(MAIN + 'dimension')
            if dimension is not None:
                for ref in dimension.get('ref', '').split(':'):
                    cell_ref(ref)
            cells, invalid, merges = {}, set(), []
            for cell in root.iter(MAIN + 'c'):
                location = cell_ref(cell.get('r'))
                if location in cells:
                    raise ImportProblem('Duplicate worksheet cell.')
                total_cells += 1
                if total_cells > MAX_CELLS:
                    raise ImportProblem('Workbook cell limit exceeded.')
                value = cell.findtext(MAIN + 'v', '')
                if cell.get('t') == 's':
                    if not value.isdigit() or int(value) >= len(shared):
                        raise ImportProblem('Shared string reference is invalid.')
                    value = shared[int(value)]
                elif cell.get('t') == 'inlineStr':
                    inline = cell.find(MAIN + 'is')
                    value = rich_text(inline) if inline is not None else ''
                elif cell.get('s') in formats and re.fullmatch(r'\d+', value):
                    value = value.zfill(formats[cell.get('s')])
                cells[location] = {'value': text(value), 'formula': cell.find(MAIN + 'f') is not None}
            touched = set()
            for merge in root.iter(MAIN + 'mergeCell'):
                refs = merge.get('ref', '').split(':')
                if len(refs) != 2:
                    raise ImportProblem('Merged range is invalid.')
                (r1, c1), (r2, c2) = map(cell_ref, refs)
                if r1 > r2 or c1 > c2 or (r2 - r1 + 1) * (c2 - c1 + 1) > MAX_CELLS:
                    raise ImportProblem('Merged range exceeds its limits.')
                locations = {(r, c) for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)}
                ambiguous = c1 != c2 or bool(locations & touched) or any(cells.get(point, {}).get('value') for point in locations - {(r1, c1)})
                if ambiguous:
                    invalid.update(locations)
                else:
                    anchor = cells.get((r1, c1), {'value': '', 'formula': False})
                    for location in locations:
                        cells[location] = anchor.copy()
                touched.update(locations)
                if len(touched) > MAX_CELLS:
                    raise ImportProblem('Merged cell limit exceeded.')
                merges.append(merge.get('ref'))
            sheets.append({'name': text(sheet.get('name', '')), 'cells': cells, 'invalid': invalid, 'merges': merges})
        return sheets


def read_delimited(data, extension):
    try:
        source = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise ImportProblem('Use a UTF-8 CSV or TSV file.') from None
    delimiter = '\t' if extension == 'tsv' else ','
    try:
        delimiter = csv.Sniffer().sniff(source[:8192], delimiters=',\t;').delimiter
    except csv.Error:
        pass
    csv.field_size_limit(MAX_TEXT)
    cells, count = {}, 0
    try:
        for row_number, row in enumerate(csv.reader(io.StringIO(source, newline=''), delimiter=delimiter, strict=True), 1):
            if row_number > MAX_ROWS or len(row) > MAX_COLS:
                raise ImportProblem('Table dimensions exceed their limits.')
            for col, value in enumerate(row, 1):
                count += 1
                if count > MAX_CELLS:
                    raise ImportProblem('Table cell limit exceeded.')
                cells[row_number, col] = {'value': text(value), 'formula': value.startswith('=')}
    except csv.Error:
        raise ImportProblem('The delimited table is invalid or exceeds its limits.') from None
    return [{'name': 'Table', 'cells': cells, 'invalid': set(), 'merges': []}]


def table(request):
    data = bounded_file(request['input'], MAX_FILE)
    extension = request.get('format')
    if extension not in ('xlsx', 'csv', 'tsv'):
        raise ImportProblem('Use XLSX, CSV or TSV.')
    sheets = read_xlsx(data) if extension == 'xlsx' else read_delimited(data, extension)
    chosen = request.get('sheet', sheets[0]['name'])
    sheet = next((item for item in sheets if item['name'] == chosen), None)
    if sheet is None:
        raise ImportProblem('Choose an available sheet.')
    cells = sheet['cells']
    header = request.get('headerRow')
    if header is None:
        header = next((row for row in range(1, 31) if sum(bool(cells.get((row, col), {}).get('value', '').strip()) for col in range(1, MAX_COLS + 1)) >= 2), 1)
    if not isinstance(header, int) or isinstance(header, bool) or not 1 <= header <= MAX_ROWS:
        raise ImportProblem('Choose a valid header row.')
    width = max((col for (_, col) in cells), default=0)
    columns = [{'id': column_name(col), 'label': cells.get((header, col), {}).get('value', '') if not cells.get((header, col), {}).get('formula') else '(formula)'} for col in range(1, width + 1)]
    vertical = sum(cell_ref(merge.split(':')[0])[1] == cell_ref(merge.split(':')[1])[1] for merge in sheet['merges'])
    result = {'sheets': [item['name'] for item in sheets], 'sheet': chosen, 'headerRow': header, 'columns': columns, 'mergeCount': len(sheet['merges']), 'verticalMergeCount': vertical}
    if request.get('action') == 'inspect':
        return result
    mapping = request.get('columns')
    if not isinstance(mapping, dict) or set(mapping) - {'sku', 'product', 'dose'} or not mapping.get('sku') or not mapping.get('product'):
        raise ImportProblem('Choose SKU and Product columns, and optionally Dose.')
    indexes = {key: column(value) for key, value in mapping.items() if value}
    if len(set(indexes.values())) != len(indexes):
        raise ImportProblem('Choose different columns for each field.')
    for col in indexes.values():
        label = cells.get((header, col), {}).get('value', '')
        if re.search(r'price|cost|售价|原价|价格|成本', label, re.I):
            raise ImportProblem('Price columns cannot be imported as product identity.')
    rows = []
    for row in sorted({r for r, _ in cells if r > header}):
        values = {key: cells.get((row, col), {}).get('value', '').strip() for key, col in indexes.items()}
        if not any(values.values()):
            continue
        error = ''
        if any(cells.get((row, col), {}).get('formula') for col in indexes.values()):
            error = 'Formula in a selected identity column.'
        elif any((row, col) in sheet['invalid'] for col in indexes.values()):
            error = 'Ambiguous merged identity cells.'
        elif not values.get('sku') or not values.get('product'):
            error = 'Missing SKU or Product.'
        rows.append({'row': row, **values, 'error': error})
    return {**result, 'rows': rows}


def images(request):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 20_000_000
    files = request.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= 500:
        raise ImportProblem('Choose between 1 and 500 images.')
    destination = Path(request['outputDirectory'])
    destination.mkdir(exist_ok=True)
    result, total = [], 0
    for item in files:
        identifier = item.get('id', '')
        if not re.fullmatch('[a-f0-9]{32}', identifier):
            raise ImportProblem('Invalid image identifier.')
        data = bounded_file(item['input'], MAX_FILE)
        suffix = Path(item['name']).suffix.lower()
        expected = {'.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP'}.get(suffix)
        if expected is None:
            raise ImportProblem('Use PNG, JPEG or WebP images.')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error')
                with Image.open(io.BytesIO(data)) as image:
                    if image.format != expected or image.width * image.height > 20_000_000 or image.width < 1 or image.height < 1:
                        raise ValueError()
                    image.verify()
                with Image.open(io.BytesIO(data)) as image:
                    image.load()
                    filename = identifier + '.png'
                    if image.format == 'PNG':
                        # Preserve PNG pixels, bit depth and bytes exactly.
                        (destination / filename).write_bytes(data)
                    else:
                        image.convert('RGBA').save(destination / filename, format='PNG')
                    if (destination / filename).stat().st_size > MAX_FILE:
                        raise ValueError()
                    total += (destination / filename).stat().st_size
                    if total > 512 * 1024 * 1024:
                        raise ValueError()
                    result.append({'id': identifier, 'name': item['name'], 'file': filename, 'sha256': hashlib.sha256((destination / filename).read_bytes()).hexdigest(), 'width': image.width, 'height': image.height})
        except Exception:
            raise ImportProblem('An image could not be decoded safely. Check its format and dimensions.') from None
    return {'images': result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        request = json.loads(bounded_file(args.request, 1024 * 1024))
        result = images(request) if request.get('action') == 'images' else table(request)
        encoded = json.dumps(result, ensure_ascii=False).encode('utf-8')
        if len(encoded) > 16 * 1024 * 1024:
            raise ImportProblem('Parsed output exceeds its size limit.')
    except ImportProblem as error:
        encoded = json.dumps({'error': str(error)}).encode('utf-8')
    except Exception:
        encoded = b'{"error":"Import input could not be processed safely."}'
    Path(args.output).write_bytes(encoded)


if __name__ == '__main__':
    main()
