"""
把 js/qrcode.js 的输出与 Python qrcode 库做逐掩码比对。

两个独立实现若在所有掩码下矩阵完全一致，说明数据编码、RS 纠错、
模块放置、掩码与格式信息的实现都符合 ISO/IEC 18004。

用法：
    set PYTHONPATH=C:/Users/Administrator/.workbuddy/binaries/python/pkgs
    python tools/verify/compare_qr.py tools/verify/js_matrices.json
"""
import json
import sys

import qrcode
from qrcode.constants import ERROR_CORRECT_M
from qrcode.util import QRData, MODE_8BIT_BYTE


def main(json_path):
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    total = 0
    passed = 0
    failed = []

    for text, per_mask in data.items():
        label = text if len(text) <= 40 else text[:37] + '...'
        for mask_key, js_matrix in per_mask.items():
            if isinstance(js_matrix, str):
                print(f'  [SKIP] {label} mask={mask_key}: {js_matrix}')
                continue
            if mask_key == 'auto':
                # 自动模式只检查能否被正确解码，不比对具体掩码
                continue

            total += 1
            size = len(js_matrix)
            version = (size - 17) // 4

            try:
                q = qrcode.QRCode(
                    version=version,
                    error_correction=ERROR_CORRECT_M,
                    box_size=1,
                    border=0,
                    mask_pattern=int(mask_key),
                )
                q.add_data(QRData(text.encode('utf-8'), mode=MODE_8BIT_BYTE))
                q.make(fit=False)
                py_matrix = [[1 if cell else 0 for cell in row] for row in q.get_matrix()]
            except Exception as e:  # noqa: BLE001
                failed.append((label, mask_key, f'python 侧异常: {e}'))
                continue

            if py_matrix == js_matrix:
                passed += 1
            else:
                diff = 0
                first = None
                for y in range(min(len(py_matrix), size)):
                    row_p, row_j = py_matrix[y], js_matrix[y]
                    for x in range(min(len(row_p), len(row_j))):
                        if row_p[x] != row_j[x]:
                            diff += 1
                            if first is None:
                                first = (x, y)
                failed.append((label, mask_key, f'{diff} 处不同，首个位置 {first}'))

    print(f'\n比对结果: {passed}/{total} 通过')
    if failed:
        print('\n不一致项:')
        for label, mask, msg in failed:
            print(f'  - {label} (mask={mask}): {msg}')
        return 1
    print('全部一致：JS 实现与 Python qrcode 库输出完全相同')
    return 0


if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else 'tools/verify/js_matrices.json'
    sys.exit(main(target))
