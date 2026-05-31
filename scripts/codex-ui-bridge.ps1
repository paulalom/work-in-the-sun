param(
  [ValidateSet("send", "read", "screenshot")]
  [string]$Action = "send",
  [string]$Text = "",
  [string]$TargetLabel = "",
  [string]$Submit = "true",
  [string]$Highlight = "true",
  [int]$MaxChars = 20000
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class User32Bridge {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
}
"@

$MouseLeftDown = 0x0002
$MouseLeftUp = 0x0004
$ShowRestore = 9
$DwmwaExtendedFrameBounds = 9

function Convert-BridgeBoolean {
  param([string]$Value, [bool]$Default)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Default
  }

  switch ($Value.Trim().ToLowerInvariant()) {
    { $_ -in @("1", "true", "`$true", "yes", "on") } { return $true }
    { $_ -in @("0", "false", "`$false", "no", "off") } { return $false }
    default { throw "Invalid boolean value: $Value" }
  }
}

$Submit = Convert-BridgeBoolean $Submit $true
$Highlight = Convert-BridgeBoolean $Highlight $true

function Write-JsonResult {
  param($Value)
  $Value | ConvertTo-Json -Depth 8 -Compress
}

function Get-CodexWindow {
  $window = Get-Process |
    Where-Object { $_.ProcessName -ieq "Codex" -and $_.MainWindowHandle -ne 0 } |
    Sort-Object Id |
    Select-Object -First 1

  if (-not $window) {
    throw "Codex desktop window was not found."
  }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.MainWindowHandle)

  if (-not $root) {
    throw "Codex desktop window is not available through Windows UI Automation."
  }

  [pscustomobject]@{
    Process = $window
    Root = $root
  }
}

function Normalize-MatchText {
  param([string]$Value)
  return ($Value -replace "[^a-zA-Z0-9]+", " ").Trim().ToLowerInvariant()
}

function Get-Descendants {
  param($Root)
  $Root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
}

function Get-ElementInfo {
  param($Element)
  $current = $Element.Current
  $rect = $current.BoundingRectangle
  [pscustomobject]@{
    name = [string]$current.Name
    className = [string]$current.ClassName
    controlType = $current.ControlType.ProgrammaticName.Replace("ControlType.", "")
    rect = [pscustomobject]@{
      x = [int][Math]::Max(-2147483648, [Math]::Min(2147483647, $rect.X))
      y = [int][Math]::Max(-2147483648, [Math]::Min(2147483647, $rect.Y))
      width = [int][Math]::Max(0, [Math]::Min(2147483647, $rect.Width))
      height = [int][Math]::Max(0, [Math]::Min(2147483647, $rect.Height))
    }
  }
}

function Get-WindowBounds {
  param([IntPtr]$Handle)

  $rect = New-Object User32Bridge+RECT
  $rectSize = [Runtime.InteropServices.Marshal]::SizeOf([type][User32Bridge+RECT])
  $dwmResult = [User32Bridge]::DwmGetWindowAttribute(
    $Handle,
    $DwmwaExtendedFrameBounds,
    [ref]$rect,
    $rectSize
  )

  if ($dwmResult -ne 0 -or ($rect.Right -le $rect.Left) -or ($rect.Bottom -le $rect.Top)) {
    if (-not [User32Bridge]::GetWindowRect($Handle, [ref]$rect)) {
      throw "Codex window bounds could not be read."
    }
  }

  $width = [Math]::Max(0, $rect.Right - $rect.Left)
  $height = [Math]::Max(0, $rect.Bottom - $rect.Top)

  if ($width -lt 1 -or $height -lt 1) {
    throw "Codex window has no visible area."
  }

  [pscustomobject]@{
    x = [int]$rect.Left
    y = [int]$rect.Top
    width = [int]$width
    height = [int]$height
  }
}

function Capture-WindowImage {
  param([IntPtr]$Handle)

  $bounds = Get-WindowBounds $Handle
  $bitmap = New-Object System.Drawing.Bitmap $bounds.width, $bounds.height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = New-Object System.IO.MemoryStream

  try {
    $graphics.CopyFromScreen(
      $bounds.x,
      $bounds.y,
      0,
      0,
      (New-Object System.Drawing.Size $bounds.width, $bounds.height),
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)

    [pscustomobject]@{
      bounds = $bounds
      width = $bounds.width
      height = $bounds.height
      imageBase64 = [Convert]::ToBase64String($stream.ToArray())
    }
  } finally {
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Find-Composer {
  param($Root)

  $all = Get-Descendants $Root
  $rootRect = $Root.Current.BoundingRectangle
  $minY = $rootRect.Y + ($rootRect.Height * 0.50)

  for ($i = $all.Count - 1; $i -ge 0; $i--) {
    $element = $all.Item($i)
    $current = $element.Current
    $rect = $current.BoundingRectangle
    $className = [string]$current.ClassName

    if (
      $current.IsEnabled -and
      $current.IsKeyboardFocusable -and
      $className.Contains("ProseMirror") -and
      $rect.Y -ge $minY -and
      $rect.Width -gt 180 -and
      $rect.Height -gt 20
    ) {
      return $element
    }
  }

  for ($i = $all.Count - 1; $i -ge 0; $i--) {
    $element = $all.Item($i)
    $current = $element.Current
    $rect = $current.BoundingRectangle

    if (
      $current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
      $current.IsEnabled -and
      $current.IsKeyboardFocusable -and
      $rect.Y -ge $minY -and
      $rect.Width -gt 180
    ) {
      return $element
    }
  }

  throw "Codex input box was not found."
}

function Get-DocumentText {
  param($Root, [int]$Limit)

  $document = $Root.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      "RootWebArea"
    )
  )

  if (-not $document) {
    $document = $Root
  }

  try {
    $textPattern = $document.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    return $textPattern.DocumentRange.GetText($Limit)
  } catch {
    return $document.Current.Name
  }
}

function Get-VisibleChatTitle {
  param($Root)
  $all = Get-Descendants $Root
  $rootRect = $Root.Current.BoundingRectangle

  for ($i = 0; $i -lt $all.Count; $i++) {
    $element = $all.Item($i)
    $current = $element.Current
    $rect = $current.BoundingRectangle
    $name = [string]$current.Name

    if (
      $current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
      $name.Trim() -and
      $rect.X -gt ($rootRect.X + 250) -and
      $rect.Y -gt ($rootRect.Y + 40) -and
      $rect.Y -lt ($rootRect.Y + 170)
    ) {
      return $name.Trim()
    }
  }

  return ""
}

function Invoke-Element {
  param($Element)

  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return
  } catch {
    $rect = $Element.Current.BoundingRectangle
    Invoke-MouseClick ($rect.X + ($rect.Width / 2)) ($rect.Y + ($rect.Height / 2))
  }
}

function Select-TargetChat {
  param($Root, [string]$Label)

  $query = Normalize-MatchText $Label

  if (-not $query) {
    return Get-VisibleChatTitle $Root
  }

  $currentTitle = Get-VisibleChatTitle $Root
  $current = Normalize-MatchText $currentTitle

  if ($current -and ($current.Contains($query) -or $query.Contains($current))) {
    return $currentTitle
  }

  $all = Get-Descendants $Root
  $rootRect = $Root.Current.BoundingRectangle

  for ($i = 0; $i -lt $all.Count; $i++) {
    $element = $all.Item($i)
    $currentElement = $element.Current
    $rect = $currentElement.BoundingRectangle
    $name = [string]$currentElement.Name
    $normalizedName = Normalize-MatchText $name

    if (
      $normalizedName -and
      ($normalizedName.Contains($query) -or $query.Contains($normalizedName)) -and
      $rect.X -lt ($rootRect.X + 380) -and
      $rect.Width -gt 50 -and
      (
        $currentElement.ControlType -eq [System.Windows.Automation.ControlType]::Button -or
        $currentElement.ControlType -eq [System.Windows.Automation.ControlType]::ListItem
      )
    ) {
      Invoke-Element $element
      Start-Sleep -Milliseconds 900
      return Get-VisibleChatTitle $Root
    }
  }

  throw "Codex chat '$Label' was not visible in the sidebar."
}

function Invoke-MouseClick {
  param([double]$X, [double]$Y)
  [User32Bridge]::SetCursorPos([int]$X, [int]$Y) | Out-Null
  Start-Sleep -Milliseconds 60
  [User32Bridge]::mouse_event($MouseLeftDown, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [User32Bridge]::mouse_event($MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
}

function Show-Highlight {
  param($Rect)

  if (-not $Highlight) {
    return
  }

  $form = New-Object System.Windows.Forms.Form
  $form.StartPosition = "Manual"
  $form.FormBorderStyle = "None"
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.BackColor = [System.Drawing.Color]::Magenta
  $form.TransparencyKey = [System.Drawing.Color]::Magenta
  $form.Bounds = New-Object System.Drawing.Rectangle(
    [int]$Rect.X,
    [int]$Rect.Y,
    [Math]::Max(1, [int]$Rect.Width),
    [Math]::Max(1, [int]$Rect.Height)
  )
  $form.Add_Paint({
    param($sender, $event)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 45, 212, 191), 4)
    $event.Graphics.DrawRectangle($pen, 2, 2, $sender.Width - 5, $sender.Height - 5)
    $pen.Dispose()
  })

  $form.Show()
  $form.Refresh()
  Start-Sleep -Milliseconds 450
  $form.Close()
  $form.Dispose()
}

function Set-ClipboardTextTemporarily {
  param([string]$Value)

  $previous = $null
  try {
    $previous = [System.Windows.Forms.Clipboard]::GetDataObject()
  } catch {
    $previous = $null
  }

  [System.Windows.Forms.Clipboard]::SetText($Value)
  return $previous
}

function Restore-Clipboard {
  param($Previous)

  if ($null -eq $Previous) {
    return
  }

  try {
    [System.Windows.Forms.Clipboard]::SetDataObject($Previous, $true)
  } catch {
    # Clipboard ownership is best-effort. Avoid failing the delivery after paste.
  }
}

try {
  [User32Bridge]::SetProcessDPIAware() | Out-Null

  $window = Get-CodexWindow
  [User32Bridge]::ShowWindow([IntPtr]$window.Process.MainWindowHandle, $ShowRestore) | Out-Null
  [User32Bridge]::SetForegroundWindow([IntPtr]$window.Process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 120

  if ($Action -eq "read") {
    $documentText = Get-DocumentText $window.Root $MaxChars
    Write-JsonResult ([pscustomobject]@{
      ok = $true
      action = "read"
      windowTitle = $window.Process.MainWindowTitle
      chatTitle = Get-VisibleChatTitle $window.Root
      text = $documentText
    })
    exit 0
  }

  if ($Action -eq "screenshot") {
    $chatTitle = Select-TargetChat $window.Root $TargetLabel
    Start-Sleep -Milliseconds 250
    $capture = Capture-WindowImage ([IntPtr]$window.Process.MainWindowHandle)

    Write-JsonResult ([pscustomobject]@{
      ok = $true
      action = "screenshot"
      windowTitle = $window.Process.MainWindowTitle
      chatTitle = $chatTitle
      targetLabel = $TargetLabel
      processName = $window.Process.ProcessName
      mimeType = "image/png"
      width = $capture.width
      height = $capture.height
      bounds = $capture.bounds
      imageBase64 = $capture.imageBase64
    })
    exit 0
  }

  if (-not $Text.Trim()) {
    throw "Missing text to send."
  }

  $chatTitle = Select-TargetChat $window.Root $TargetLabel
  $composer = Find-Composer $window.Root
  $composerInfo = Get-ElementInfo $composer
  $rect = $composer.Current.BoundingRectangle

  Show-Highlight $rect

  try {
    $composer.SetFocus()
  } catch {
    # Contenteditable surfaces often focus more reliably after a mouse click.
  }

  Invoke-MouseClick ($rect.X + [Math]::Min(24, $rect.Width / 2)) ($rect.Y + [Math]::Min(20, $rect.Height / 2))
  Start-Sleep -Milliseconds 80

  $oldClipboard = Set-ClipboardTextTemporarily $Text
  try {
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 120

    if ($Submit) {
      [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    }
  } finally {
    Start-Sleep -Milliseconds 120
    Restore-Clipboard $oldClipboard
  }

  Write-JsonResult ([pscustomobject]@{
    ok = $true
    action = "send"
    submitted = $Submit
    windowTitle = $window.Process.MainWindowTitle
    chatTitle = $chatTitle
    targetLabel = $TargetLabel
    composer = $composerInfo
  })
  exit 0
} catch {
  Write-JsonResult ([pscustomobject]@{
    ok = $false
    action = $Action
    error = $_.Exception.Message
  })
  exit 1
}
