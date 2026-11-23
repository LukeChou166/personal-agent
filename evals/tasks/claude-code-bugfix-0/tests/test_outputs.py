"""评测 claude-code 任务的 verifier 测试。"""

import sys

sys.path.insert(0, "/app")

from buggy import add, multiply  # noqa: E402


def check():
    assert add(2, 3) == 5, "add(2, 3) 应为 5"
    assert add(-1, 1) == 0, "add(-1, 1) 应为 0"
    assert add(100, 200) == 300, "add(100, 200) 应为 300"
    assert multiply(3, 4) == 12, "multiply(3, 4) 应为 12"
    assert multiply(0, 5) == 0, "multiply(0, 5) 应为 0"


check()
print("All tests passed.")
