"""从标准输入读取 RSS/Atom XML，输出标题、链接、发布时间。"""
import json
import sys
import xml.etree.ElementTree as ET


def parse(raw):
    root = ET.fromstring(raw)
    items = []
    for entry in root.iter():
        if entry.tag.split('}')[-1] not in ('item', 'entry'):
            continue
        fields = {child.tag.split('}')[-1]: child for child in entry}
        def value(key):
            node = fields.get(key)
            return ''.join(node.itertext()).strip() if node is not None else ''
        link = value('link')
        if not link:
            link = next((node.get('href', '') for node in entry
                         if node.tag.split('}')[-1] == 'link'
                         and node.get('rel', 'alternate') == 'alternate'), '')
        items.append({'title': value('title'), 'url': link,
                      'publishedAt': value('pubDate') or value('published') or value('updated') or value('date')})
    return {'items': items}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(parse(sys.stdin.buffer.read()), ensure_ascii=False))
