' Double-click to open Lend-Wise (runs Node in the background, no terminal).
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & here & "\launch.mjs""", 0, False
