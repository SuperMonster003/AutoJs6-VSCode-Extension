@ECHO OFF
CHCP 65001 >NUL
WHERE py >NUL 2>NUL
IF ERRORLEVEL 1 (
    python "%~dp0generate_markdown.py" %*
) ELSE (
    py -3 "%~dp0generate_markdown.py" %*
)
EXIT /B %ERRORLEVEL%
