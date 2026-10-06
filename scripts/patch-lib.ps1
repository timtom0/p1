# Shared prologue for the patch scripts in this folder.
#
# Four things it does that every script otherwise gets wrong:
#
#  1. **Normalises line endings.** The tree has mixed CRLF and LF (noted in the M6 notes), and a
#     PowerShell here-string is written with CRLF, so a multi-line pattern never matches a file
#     stored with LF -- and `edit`/`Replace` then silently no-ops.
#  2. **Matches across dash and quote variants.** Prose in this repository uses real em dashes
#     and curly quotes. This shell reads a BOM-less `.ps1` as Windows-1252, so those characters
#     arrive here as mojibake and cannot match the UTF-8 file. `Normalise` undoes the damage on
#     both sides before matching, and `savePatched` undoes it on the way out -- so a script can
#     be written with the character it means and still patch a file that has it.
#  3. **Slices by index, not by rewriting.** Matching happens in folded space and the
#     replacement is applied to the original by mapped index, so folding never corrupts the text
#     it did not mean to touch.
#  4. **Refuses to write nothing.** `WriteAllText(path, $null)` truncates a file to zero bytes
#     without raising anything, which is the worst possible failure for a patch tool.
$path = $args[0]
$raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8).Replace("`r`n", "`n")

# The exact byte sequences Windows-1252 produces for the characters this repository uses, and
# what they were meant to be. Listed rather than pattern-matched: a general "looks wrong" fix
# would be a general "quietly edits your source" fix.
$Repairs = @(
  @([string][char]0x00C2 + [char]0x00A7, [string][char]0x00A7),                    # section sign
  @([string][char]0x00C2 + [char]0x00B7, [string][char]0x00B7),                    # middle dot
  @([string][char]0x00E2 + [char]0x20AC + [char]0x201D, [string][char]0x2014),      # em dash
  @([string][char]0x00E2 + [char]0x20AC + [char]0x201C, [string][char]0x2013),      # en dash
  @([string][char]0x00E2 + [char]0x20AC + [char]0x0153, [string][char]0x201C),      # left double quote
  @([string][char]0x00E2 + [char]0x20AC + [char]0x2122, [string][char]0x2019),      # right single quote
  @([string][char]0x00E2 + [char]0x20AC + [char]0x009D, [string][char]0x201D)       # right double quote
)

function Normalise([string]$text) {
  foreach ($pair in $script:Repairs) { $text = $text.Replace($pair[0], $pair[1]) }
  return $text
}

# Folds one character to an ASCII stand-in, for matching only. Em dash and curly quotes fold to
# their ASCII equivalents so a pattern written with either spelling matches a file with the
# other; the replacement is unaffected, because it is applied to the original by index.
function Fold([char]$c) {
  switch ([int]$c) {
    0x2014 { return '--' }   # em dash
    0x2013 { return '-' }    # en dash
    0x2018 { return "'" }    # left single quote
    0x2019 { return "'" }    # right single quote
    0x201C { return '"' }    # left double quote
    0x201D { return '"' }    # right double quote
    0x00A0 { return ' ' }     # non-breaking space
    default { return [string]$c }
  }
}

# Returns the folded text plus, for each folded character, the index it came from. That is what
# lets a match found in folded space be applied to the original without touching it.
function Folded([string]$text) {
  $builder = New-Object System.Text.StringBuilder
  $map = New-Object 'System.Collections.Generic.List[int]'
  $source = Normalise $text
  for ($i = 0; $i -lt $source.Length; $i += 1) {
    foreach ($piece in (Fold $source[$i]).ToCharArray()) {
      [void]$builder.Append($piece)
      [void]$map.Add($i)
    }
  }
  # A sentinel so an end index past the last character still maps.
  [void]$map.Add($source.Length)
  return @{ Text = $builder.ToString(); Map = $map }
}

$foldedRaw = Folded $raw

# What the scripts edit, and what `savePatched` writes. Set here rather than by each script,
# because a script that forgets leaves this null -- and `WriteAllText(path, $null)` truncates
# the file to nothing without complaining.
$script:text = $raw

function replaceOnce([string]$from, [string]$to) {
  $from = $from.Replace("`r`n", "`n")
  $to = $to.Replace("`r`n", "`n")
  $needle = (Folded $from).Text

  $at = $script:foldedRaw.Text.IndexOf($needle, [System.StringComparison]::Ordinal)
  if ($at -lt 0) { throw "not found in ${script:path}:`n$from" }

  $map = $script:foldedRaw.Map
  $startIndex = $map[$at]
  $endIndex = $map[$at + $needle.Length]
  $script:text = $script:text.Remove($startIndex, $endIndex - $startIndex).Insert($startIndex, $to)
  $script:foldedRaw = Folded $script:text
}

function replaceRegex([string]$pattern, [string]$to) {
  $before = $script:text
  $script:text = [regex]::Replace($script:text, $pattern, $to)
  if ($script:text -eq $before) { throw "regex matched nothing in ${script:path}: $pattern" }
  $script:foldedRaw = Folded $script:text
}

function savePatched {
  if ($null -eq $script:text -or $script:text.Length -eq 0) {
    throw "refusing to write an empty ${script:path}: `$$script:text is null or zero-length"
  }
  # Repair before writing. The damage was done when this shell read the script, so undoing it
  # here means a patch script can be written with the character it means.
  $out = Normalise $script:text
  [System.IO.File]::WriteAllText($script:path, $out, (New-Object System.Text.UTF8Encoding($false)))
  'patched'
}
