"""
Test Runner Delegate - Multi-framework test execution subagent.

This delegate runs test suites across multiple frameworks and returns
structured results with pass/fail counts and failure details.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("hester.daemon.tasks.test_runner_delegate")


class TestFramework(str, Enum):
    """Supported test frameworks."""

    PYTEST = "pytest"
    FLUTTER = "flutter"
    JEST = "jest"
    AUTO = "auto"  # Auto-detect from path


@dataclass
class TestResult:
    """Result of a single test."""

    name: str
    status: str  # passed, failed, skipped, error
    duration: Optional[float] = None
    message: Optional[str] = None
    location: Optional[str] = None


@dataclass
class TestSuiteResult:
    """Result of a test suite run."""

    framework: str
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    errors: int = 0
    duration: float = 0.0
    tests: List[TestResult] = field(default_factory=list)
    raw_output: str = ""
    exit_code: int = 0

    @property
    def total(self) -> int:
        return self.passed + self.failed + self.skipped + self.errors

    @property
    def success(self) -> bool:
        return self.failed == 0 and self.errors == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "framework": self.framework,
            "passed": self.passed,
            "failed": self.failed,
            "skipped": self.skipped,
            "errors": self.errors,
            "total": self.total,
            "duration": self.duration,
            "success": self.success,
            "exit_code": self.exit_code,
            "tests": [asdict(t) for t in self.tests],
        }


class TestRunnerDelegate:
    """
    Test runner delegate for executing test suites.

    Supports:
    - pytest (Python)
    - flutter test (Dart)
    - jest (JavaScript/TypeScript)

    Auto-detects framework from path if not specified.
    Returns structured results with pass/fail counts.
    """

    def __init__(self, working_dir: Path):
        """
        Initialize the test runner delegate.

        Args:
            working_dir: Working directory for running tests
        """
        self.working_dir = Path(working_dir)
        logger.info(f"TestRunnerDelegate initialized: working_dir={working_dir}")

    def _detect_framework(self, path: str) -> TestFramework:
        """
        Auto-detect test framework from path.

        Args:
            path: Test path or directory

        Returns:
            Detected TestFramework
        """
        test_path = Path(path)

        # Check file extension
        if test_path.suffix == ".py":
            return TestFramework.PYTEST
        elif test_path.suffix == ".dart":
            return TestFramework.FLUTTER
        elif test_path.suffix in (".js", ".ts", ".jsx", ".tsx"):
            return TestFramework.JEST

        # Check directory contents
        full_path = self.working_dir / path if not test_path.is_absolute() else test_path

        if full_path.is_dir():
            # Look for framework indicators
            if (full_path / "pubspec.yaml").exists() or any(
                full_path.glob("**/*.dart")
            ):
                return TestFramework.FLUTTER
            elif (full_path / "package.json").exists() or any(
                full_path.glob("**/*.test.{js,ts,jsx,tsx}")
            ):
                return TestFramework.JEST
            elif any(full_path.glob("**/test_*.py")) or any(
                full_path.glob("**/*_test.py")
            ):
                return TestFramework.PYTEST

        # Check parent directories for framework files
        search_path = full_path if full_path.is_dir() else full_path.parent
        for parent in [search_path] + list(search_path.parents)[:3]:
            if (parent / "pubspec.yaml").exists():
                return TestFramework.FLUTTER
            elif (parent / "pytest.ini").exists() or (parent / "pyproject.toml").exists():
                return TestFramework.PYTEST
            elif (parent / "jest.config.js").exists() or (parent / "jest.config.ts").exists():
                return TestFramework.JEST

        # Default to pytest
        return TestFramework.PYTEST

    def _build_pytest_command(
        self,
        path: str,
        args: Optional[List[str]] = None,
    ) -> List[str]:
        """Build pytest command with arguments."""
        cmd = ["python", "-m", "pytest"]

        # Add path
        cmd.append(path)

        # Add verbose output for parsing
        cmd.extend(["-v", "--tb=short"])

        # Add any extra args
        if args:
            cmd.extend(args)

        return cmd

    def _build_flutter_command(
        self,
        path: str,
        args: Optional[List[str]] = None,
    ) -> List[str]:
        """Build flutter test command with arguments."""
        cmd = ["flutter", "test"]

        # Add path if specific file/directory
        if path and path != ".":
            cmd.append(path)

        # Add reporter for better output
        cmd.append("--reporter=expanded")

        # Add any extra args
        if args:
            cmd.extend(args)

        return cmd

    def _build_jest_command(
        self,
        path: str,
        args: Optional[List[str]] = None,
    ) -> List[str]:
        """Build jest command with arguments."""
        cmd = ["npx", "jest"]

        # Add path
        if path and path != ".":
            cmd.append(path)

        # Add verbose and JSON output
        cmd.extend(["--verbose", "--no-coverage"])

        # Add any extra args
        if args:
            cmd.extend(args)

        return cmd

    def _parse_pytest_output(
        self,
        output: str,
        exit_code: int,
    ) -> TestSuiteResult:
        """Parse pytest output into structured result."""
        result = TestSuiteResult(
            framework="pytest",
            raw_output=output,
            exit_code=exit_code,
        )

        # Parse summary line: "X passed, Y failed, Z skipped in N.NNs"
        summary_match = re.search(
            r"(\d+) passed.*?in ([\d.]+)s",
            output,
            re.IGNORECASE,
        )
        if summary_match:
            result.passed = int(summary_match.group(1))
            result.duration = float(summary_match.group(2))

        failed_match = re.search(r"(\d+) failed", output, re.IGNORECASE)
        if failed_match:
            result.failed = int(failed_match.group(1))

        skipped_match = re.search(r"(\d+) skipped", output, re.IGNORECASE)
        if skipped_match:
            result.skipped = int(skipped_match.group(1))

        error_match = re.search(r"(\d+) error", output, re.IGNORECASE)
        if error_match:
            result.errors = int(error_match.group(1))

        # Parse individual test results
        # Format: "path/to/test.py::test_name PASSED/FAILED"
        test_pattern = re.compile(
            r"([^\s]+\.py)::(\S+)\s+(PASSED|FAILED|SKIPPED|ERROR)(?:\s+\[([\d.]+)s\])?"
        )
        for match in test_pattern.finditer(output):
            test = TestResult(
                name=match.group(2),
                location=match.group(1),
                status=match.group(3).lower(),
                duration=float(match.group(4)) if match.group(4) else None,
            )
            result.tests.append(test)

        # Extract failure messages
        failure_pattern = re.compile(
            r"FAILED ([^\s]+\.py::(\S+))\s*-\s*(.+?)(?=\n(?:FAILED|PASSED|={5,}|$))",
            re.DOTALL,
        )
        for match in failure_pattern.finditer(output):
            test_name = match.group(2)
            message = match.group(3).strip()
            # Find matching test and add message
            for test in result.tests:
                if test.name == test_name:
                    test.message = message[:500]  # Truncate long messages
                    break

        return result

    def _parse_flutter_output(
        self,
        output: str,
        exit_code: int,
    ) -> TestSuiteResult:
        """Parse flutter test output into structured result."""
        result = TestSuiteResult(
            framework="flutter",
            raw_output=output,
            exit_code=exit_code,
        )

        # Parse summary: "00:05 +10 -2: All tests passed!" or similar
        summary_match = re.search(
            r"(\d+):(\d+)\s+\+(\d+)(?:\s+-(\d+))?(?:\s+~(\d+))?:",
            output,
        )
        if summary_match:
            minutes = int(summary_match.group(1))
            seconds = int(summary_match.group(2))
            result.duration = minutes * 60 + seconds
            result.passed = int(summary_match.group(3))
            result.failed = int(summary_match.group(4) or 0)
            result.skipped = int(summary_match.group(5) or 0)

        # Parse individual test results
        # Format: "00:01 +1: test description"
        test_pattern = re.compile(
            r"(\d+:\d+)\s+([+\-~])(\d+)(?:\s+[+\-~]\d+)*:\s+(.+?)(?=\n\d+:\d+|\n\n|$)"
        )
        for match in test_pattern.finditer(output):
            status_char = match.group(2)
            status = {"+": "passed", "-": "failed", "~": "skipped"}.get(
                status_char, "unknown"
            )
            test = TestResult(
                name=match.group(4).strip(),
                status=status,
            )
            result.tests.append(test)

        return result

    def _parse_jest_output(
        self,
        output: str,
        exit_code: int,
    ) -> TestSuiteResult:
        """Parse jest output into structured result."""
        result = TestSuiteResult(
            framework="jest",
            raw_output=output,
            exit_code=exit_code,
        )

        # Parse summary: "Tests: X passed, Y failed, Z total"
        tests_match = re.search(
            r"Tests:\s+(?:(\d+) failed,\s+)?(?:(\d+) skipped,\s+)?(?:(\d+) passed,\s+)?(\d+) total",
            output,
        )
        if tests_match:
            result.failed = int(tests_match.group(1) or 0)
            result.skipped = int(tests_match.group(2) or 0)
            result.passed = int(tests_match.group(3) or 0)

        # Parse time
        time_match = re.search(r"Time:\s+([\d.]+)\s*s", output)
        if time_match:
            result.duration = float(time_match.group(1))

        # Parse individual test results
        # Format: "✓ test name (Xms)" or "✕ test name"
        test_pattern = re.compile(
            r"([✓✕○])\s+(.+?)(?:\s+\((\d+)\s*ms\))?\s*$",
            re.MULTILINE,
        )
        for match in test_pattern.finditer(output):
            status_char = match.group(1)
            status = {"✓": "passed", "✕": "failed", "○": "skipped"}.get(
                status_char, "unknown"
            )
            test = TestResult(
                name=match.group(2).strip(),
                status=status,
                duration=float(match.group(3)) / 1000 if match.group(3) else None,
            )
            result.tests.append(test)

        return result

    async def execute(
        self,
        path: str = ".",
        framework: TestFramework = TestFramework.AUTO,
        args: Optional[List[str]] = None,
    ) -> TestSuiteResult:
        """
        Execute test suite and return structured results.

        Args:
            path: Test file or directory path
            framework: Test framework to use (or AUTO to detect)
            args: Additional arguments to pass to test command

        Returns:
            TestSuiteResult with pass/fail counts and test details
        """
        # Resolve framework
        if framework == TestFramework.AUTO:
            framework = self._detect_framework(path)

        logger.info(f"Running {framework.value} tests on {path}")

        # Build command
        if framework == TestFramework.PYTEST:
            cmd = self._build_pytest_command(path, args)
            parser = self._parse_pytest_output
        elif framework == TestFramework.FLUTTER:
            cmd = self._build_flutter_command(path, args)
            parser = self._parse_flutter_output
        elif framework == TestFramework.JEST:
            cmd = self._build_jest_command(path, args)
            parser = self._parse_jest_output
        else:
            return TestSuiteResult(
                framework=framework.value,
                errors=1,
                raw_output=f"Unsupported framework: {framework}",
            )

        # Run tests
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(self.working_dir),
            )

            stdout, _ = await asyncio.wait_for(
                process.communicate(),
                timeout=300,  # 5 minute timeout
            )

            output = stdout.decode("utf-8", errors="replace")
            exit_code = process.returncode or 0

            # Parse output
            result = parser(output, exit_code)
            return result

        except asyncio.TimeoutError:
            return TestSuiteResult(
                framework=framework.value,
                errors=1,
                raw_output="Test execution timed out after 5 minutes",
                exit_code=124,
            )
        except Exception as e:
            logger.error(f"Test execution failed: {e}")
            return TestSuiteResult(
                framework=framework.value,
                errors=1,
                raw_output=f"Test execution failed: {e}",
                exit_code=1,
            )

    async def execute_batch(
        self,
        batch: "TaskBatch",
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a batch using this delegate.

        This method is called by TaskExecutor for test_runner batches.

        Args:
            batch: The batch to execute
            context: Context from previous batches (not typically used)

        Returns:
            Dict with success, output, and optional summary
        """
        from .models import TaskBatch

        params = batch.params or {}

        # Get test parameters
        path = params.get("path", ".")
        framework_str = params.get("framework", "auto")
        args = params.get("args", [])

        # Parse framework
        try:
            framework = TestFramework(framework_str.lower())
        except ValueError:
            framework = TestFramework.AUTO

        # Execute tests
        result = await self.execute(
            path=path,
            framework=framework,
            args=args,
        )

        # Format output
        output = self._format_output(result)
        summary = self._generate_summary(result)

        return {
            "success": result.success,
            "output": output,
            "summary": summary,
        }

    def _format_output(self, result: TestSuiteResult) -> str:
        """Format result as markdown output."""
        lines = [f"# Test Results ({result.framework})\n"]

        # Summary
        status_emoji = "✅" if result.success else "❌"
        lines.append(f"## Summary {status_emoji}\n")
        lines.append(f"- **Passed:** {result.passed}")
        lines.append(f"- **Failed:** {result.failed}")
        lines.append(f"- **Skipped:** {result.skipped}")
        if result.errors:
            lines.append(f"- **Errors:** {result.errors}")
        lines.append(f"- **Duration:** {result.duration:.2f}s")
        lines.append(f"- **Exit Code:** {result.exit_code}\n")

        # Failed tests
        failed_tests = [t for t in result.tests if t.status == "failed"]
        if failed_tests:
            lines.append("## Failed Tests\n")
            for test in failed_tests:
                lines.append(f"### {test.name}")
                if test.location:
                    lines.append(f"*Location: {test.location}*")
                if test.message:
                    lines.append(f"```\n{test.message}\n```")
                lines.append("")

        # Passed tests (abbreviated)
        passed_tests = [t for t in result.tests if t.status == "passed"]
        if passed_tests:
            lines.append(f"## Passed Tests ({len(passed_tests)})\n")
            for test in passed_tests[:10]:  # Show first 10
                duration_str = f" ({test.duration:.2f}s)" if test.duration else ""
                lines.append(f"- {test.name}{duration_str}")
            if len(passed_tests) > 10:
                lines.append(f"... and {len(passed_tests) - 10} more")

        return "\n".join(lines)

    def _generate_summary(self, result: TestSuiteResult) -> str:
        """Generate a concise summary for context chaining."""
        if result.success:
            return f"All {result.passed} tests passed in {result.duration:.1f}s"
        else:
            return f"Tests failed: {result.passed} passed, {result.failed} failed, {result.skipped} skipped"
