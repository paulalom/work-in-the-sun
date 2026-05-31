param()

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowScreenshotNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
}
"@

$DwmwaExtendedFrameBounds = 9

function Write-JsonResult {
  param($Value)
  $Value | ConvertTo-Json -Depth 8 -Compress
}

function Get-WindowTitle {
  param([IntPtr]$Handle)

  $builder = New-Object System.Text.StringBuilder 512
  [WindowScreenshotNative]::GetWindowText($Handle, $builder, $builder.Capacity) | Out-Null
  return $builder.ToString()
}

function Get-ProcessNameForWindow {
  param([IntPtr]$Handle)

  [uint32]$processId = 0
  [WindowScreenshotNative]::GetWindowThreadProcessId($Handle, [ref]$processId) | Out-Null

  if (-not $processId) {
    return ""
  }

  try {
    return (Get-Process -Id $processId).ProcessName
  } catch {
    return ""
  }
}

function Get-WindowBounds {
  param([IntPtr]$Handle)

  $rect = New-Object WindowScreenshotNative+RECT
  $rectSize = [Runtime.InteropServices.Marshal]::SizeOf([type][WindowScreenshotNative+RECT])
  $dwmResult = [WindowScreenshotNative]::DwmGetWindowAttribute(
    $Handle,
    $DwmwaExtendedFrameBounds,
    [ref]$rect,
    $rectSize
  )

  if ($dwmResult -ne 0 -or ($rect.Right -le $rect.Left) -or ($rect.Bottom -le $rect.Top)) {
    if (-not [WindowScreenshotNative]::GetWindowRect($Handle, [ref]$rect)) {
      throw "The active window bounds could not be read."
    }
  }

  $width = [Math]::Max(0, $rect.Right - $rect.Left)
  $height = [Math]::Max(0, $rect.Bottom - $rect.Top)

  if ($width -lt 1 -or $height -lt 1) {
    throw "The active window has no visible area."
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

try {
  [WindowScreenshotNative]::SetProcessDPIAware() | Out-Null

  $handle = [WindowScreenshotNative]::GetForegroundWindow()

  if ($handle -eq [IntPtr]::Zero) {
    throw "No active desktop window was found."
  }

  $capture = Capture-WindowImage $handle

  Write-JsonResult ([pscustomobject]@{
    ok = $true
    action = "screenshot"
    windowTitle = Get-WindowTitle $handle
    processName = Get-ProcessNameForWindow $handle
    mimeType = "image/png"
    width = $capture.width
    height = $capture.height
    bounds = $capture.bounds
    imageBase64 = $capture.imageBase64
  })
  exit 0
} catch {
  Write-JsonResult ([pscustomobject]@{
    ok = $false
    action = "screenshot"
    error = $_.Exception.Message
  })
  exit 1
}
