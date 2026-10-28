$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & gcc -std=c11 -Wall -Wextra -Werror -O2 raw_input_helper.c -o raw_input_helper.exe -luser32
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & .\raw_input_helper.exe --self-test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
