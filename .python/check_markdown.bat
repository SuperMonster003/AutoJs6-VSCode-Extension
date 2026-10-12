@ECHO OFF
CALL "%~dp0generate_markdown.bat" --check
EXIT /B %ERRORLEVEL%
