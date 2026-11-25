# Video Factory: one-command setup for a Windows 10/11 PC (docs/prompts/NEW_ACCOUNT_SETUP.md). Twin of install.sh.
#   irm https://video-factory.lakshmansai121.workers.dev/install.ps1 | iex
# Team members get a personal line (".../install.ps1?key=vfk_..."): the server fills in $VfKeyFromLink below, and
# the key replaces GitHub entirely (no GitHub account needed). Without a key it signs in with GitHub (the owner).
# Safe to run again: it skips whatever is already installed and only fills gaps.
# You will be asked for: "Yes" on Windows permission pop-ups (first installs only), a GitHub sign-in (no key only)
# and a Claude sign-in in the browser.
# Everything is inside Install-VideoFactory, called on the last lines: a cut-off download runs nothing.
# Works on Windows PowerShell 5.1 (what irm | iex runs on a fresh PC) and PowerShell 7. Never calls exit (under
# irm | iex that would close the window), except in CI. VF_CI=1 (CI) skips the two browser sign-ins, nothing else.

$VfKeyFromLink = ""

function Install-VideoFactory {
	$ErrorActionPreference = 'Continue' # native tools report by exit code; 'Stop' turns their stderr into errors on PS 5.1
	$ProgressPreference = 'SilentlyContinue' # PS 5.1's progress bar makes downloads many times slower
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	$dir = if ($env:VF_DIR) { $env:VF_DIR } else { Join-Path $HOME 'video-factory' }
	$repo = 'Pala-LakshmanSai/video-factory'
	$env:GIT_TERMINAL_PROMPT = '0' # git fails with a message instead of waiting for a password nobody sees
	$env:GCM_INTERACTIVE = 'never' # same for Git Credential Manager's pop-up

	function Step($t) { Write-Host "`n==> $t" -ForegroundColor White }
	function Has($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
	# New tools are found in this same window: registry PATH (what a new window gets) first, then what this one had.
	function Update-Path {
		$all = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'
		$env:Path = (($all -split ';') | Where-Object { $_ } | Select-Object -Unique) -join ';'
	}
	# Persist for new windows and the Claude app. ponytail: rewrites the user PATH expanded (%VARS% become their values).
	function Add-UserPath($d) {
		$u = [Environment]::GetEnvironmentVariable('Path', 'User')
		if (($u -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', ((@($d) + ($u -split ';')) | Where-Object { $_ }) -join ';', 'User') }
		Update-Path
	}
	function Install-Pkg($id) {
		Write-Host "installing $id..."
		winget install --accept-source-agreements --accept-package-agreements --silent -e --id $id | Out-Host
	}
	function Find-Python312 {
		$c = @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", "$env:ProgramFiles\Python312\python.exe")
		# stdin from nothing: the newer py manager offers to install a missing version and would wait for an answer
		if (Has py) { $c = @($null | py -3.12 -c 'import sys; print(sys.executable)' 2>$null) + $c }
		$c | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
	}

	# Key: env VF_KEY, else the key from the personal install line, else the one saved last time. Saved for vf.mjs.
	$keyFile = Join-Path $HOME '.video-factory\key'
	$key = if ($env:VF_KEY) { $env:VF_KEY } elseif ($VfKeyFromLink) { $VfKeyFromLink } elseif (Test-Path $keyFile) { Get-Content -Raw $keyFile } else { '' }
	$key = "$key".Trim()
	if ($key) {
		if ($key -cnotmatch '^vfk_[A-Za-z0-9]{32}$') { throw 'That access key does not look right (it starts with vfk_ and is 36 characters). Ask the owner for your install line again.' }
		New-Item -ItemType Directory -Force (Split-Path $keyFile) | Out-Null
		[IO.File]::WriteAllText($keyFile, $key) # no BOM, unlike Set-Content -Encoding UTF8 on PS 5.1
		Write-Host 'Using your Video Factory access key (no GitHub account needed).'
	} else { Write-Host 'Signing in with GitHub.' }

	Step 'Tools'
	if (-not (Has winget)) { # first login on a new PC: winget registers late; ask for it now
		try { Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop } catch {}
		Update-Path
	}
	if (-not (Has winget)) { throw 'winget (the Windows package manager) is missing. Install "App Installer" from the Microsoft Store: https://apps.microsoft.com/detail/9nblggh4nns1' }
	# Git also gives Claude Code its Git Bash.
	$want = [ordered]@{ git = 'Git.Git'; gh = 'GitHub.cli'; node = 'OpenJS.NodeJS.LTS'; ffmpeg = 'Gyan.FFmpeg'; 'yt-dlp' = 'yt-dlp.yt-dlp'; uv = 'astral-sh.uv' }
	if ($key) { $want.Remove('gh') } # the GitHub CLI only without a key
	$missing = @(foreach ($c in $want.Keys) { if (-not (Has $c)) { $want[$c] } })
	if ((Has node) -and [version]((node --version) -replace '^v') -lt [version]'22.18') { $missing += 'OpenJS.NodeJS.LTS' } # needs 22.18+
	if (-not (Find-Python312)) { $missing += 'Python.Python.3.12' }
	if ($missing) { foreach ($id in $missing) { Install-Pkg $id }; Update-Path } else { Write-Host 'all present' }
	$still = @(foreach ($c in $want.Keys) { if (-not (Has $c)) { $c } })
	if (-not (Find-Python312)) { $still += 'Python 3.12' }
	if ($still) { throw "These did not install: $($still -join ', ')." }
	# Skill instructions run python3 (in Git Bash too); Windows Python ships only python.exe, plus a python3 stub
	# that opens the Store. A copy named python3.exe next to it works.
	$ok = $false
	if (Has python3) { python3 --version *> $null; $ok = $LASTEXITCODE -eq 0 }
	if (-not $ok) {
		$py = Find-Python312
		Copy-Item $py (Join-Path (Split-Path $py) 'python3.exe') -Force -ErrorAction Stop
		Add-UserPath (Split-Path $py)
	}
	$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
	if (-not ($chrome | Where-Object { Test-Path $_ })) {
		Install-Pkg 'Google.Chrome'
		if ($LASTEXITCODE -ne 0) { Write-Host '(Chrome did not install; get it later from google.com/chrome. Continuing.)' }
	}

	if (-not $key) {
		Step 'GitHub sign-in'
		gh auth token *> $null
		if ($LASTEXITCODE -ne 0) {
			if ($env:VF_CI) { throw 'GitHub is not signed in (CI: set GH_TOKEN).' }
			Write-Host 'A browser page opens: sign in as the Video Factory owner and paste the code shown here.'
			gh auth login --hostname github.com --git-protocol https --web
			if ($LASTEXITCODE -ne 0) { throw 'GitHub sign-in did not finish.' }
		}
		gh auth setup-git
		gh auth status 2>&1 | Select-String 'Logged in' | Select-Object -First 1 | Out-Host
	}

	Step 'Transcription tool (whisper-cli)'
	if (Has whisper-cli) { Write-Host 'present' } else {
		# No winget package: the official CPU x64 build. The newest releases (v1.x) carry no files; the b-builds do.
		$api = 'repos/ggml-org/whisper.cpp/releases?per_page=20'
		# With a key there is no gh: GitHub's public API without sign-in (60 requests an hour, plenty for one install).
		$rels = if ($key) { Invoke-RestMethod -UseBasicParsing "https://api.github.com/$api" } else { (gh api $api | Out-String) | ConvertFrom-Json }
		$url = @(foreach ($r in $rels) { foreach ($a in $r.assets) { if ($a.name -eq 'whisper-bin-x64.zip') { $a.browser_download_url } } })[0]
		if (-not $url) { throw 'Could not find the whisper.cpp download on GitHub.' }
		$dest = Join-Path $env:LOCALAPPDATA 'whisper-cpp'
		$zip = Join-Path $env:TEMP 'whisper-bin-x64.zip'
		Write-Host "downloading $url"
		Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -ErrorAction Stop
		Expand-Archive $zip $dest -Force -ErrorAction Stop
		Remove-Item $zip
		$exe = Get-ChildItem $dest -Recurse -Filter whisper-cli.exe | Select-Object -First 1
		if (-not $exe) { throw "whisper-cli.exe is not in $url." }
		Add-UserPath $exe.DirectoryName
	}

	Step "Project code -> $dir"
	if (Test-Path (Join-Path $dir '.git')) {
		git -C $dir pull -q --ff-only
		if ($LASTEXITCODE -ne 0) { Write-Host '(could not fast-forward; continuing with the local copy)' }
	} else {
		if ((Test-Path $dir) -and (Get-ChildItem $dir -Force | Select-Object -First 1)) { # not the project: keep it, out of the way
			$old = "$dir.old-$(Get-Date -Format yyyyMMdd-HHmmss)"
			Move-Item $dir $old -ErrorAction Stop
			Write-Host "An older folder was in the way; moved it to $old"
		}
		if ($key) { # public repo: no GitHub account; GIT_TERMINAL_PROMPT and GCM_INTERACTIVE above mean no password prompt
			git clone -q "https://github.com/$repo.git" $dir
			if ($LASTEXITCODE -ne 0) { throw 'Could not download the project. Check the internet connection.' }
		} else {
			gh repo clone $repo $dir
			if ($LASTEXITCODE -ne 0) { throw 'Could not download the project. Check the internet, and that GitHub is signed in as the owner (to switch: gh auth logout).' }
		}
	}

	Step 'Claude Code command'
	$bin = Join-Path $HOME '.local\bin'
	if (-not (Has claude) -and -not (Test-Path "$bin\claude.exe")) {
		# Its own process: the official installer may call exit, which would close this window.
		powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex'
	}
	Add-UserPath $bin
	if (-not (Has claude)) { Write-Host '(Claude Code command did not install; the desktop app still works. Continuing.)' }
	if (-not $env:VF_CI -and (Has claude) -and -not ((claude auth status 2>$null | Out-String) -match '"loggedIn":\s*true')) {
		Write-Host 'A browser page opens: sign in to your Claude account (the skills use the claude command).'
		claude auth login
		if ($LASTEXITCODE -ne 0) { Write-Host '(Claude sign-in skipped; later run: claude auth login)' }
	}

	Step 'Sync skills, style kits, preferences, dependencies, voice and transcription models'
	$setupArgs = @("$env:VF_SETUP_ARGS" -split '\s+' | Where-Object { $_ })
	Push-Location $dir
	try { $null | node scripts/vf.mjs setup @setupArgs | Out-Host } finally { Pop-Location } # stdin from nothing: never waits
	if ($LASTEXITCODE -ne 0) { throw 'Setup is not finished yet: see what still needs fixing above.' }

	Write-Host "`nDone. Open the Claude app > Code tab > choose the video-factory folder ($dir), and say yes to trust the folder." -ForegroundColor Green
	Write-Host 'That turns on the automatic sync.'
}

try { Install-VideoFactory } catch {
	Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
	Write-Host 'Setup stopped before the end. Fix what is shown above if you can, then run the same line again:' -ForegroundColor Red
	Write-Host '  irm https://video-factory.lakshmansai121.workers.dev/install.ps1 | iex'
	if ($env:VF_CI) { exit 1 }
}
