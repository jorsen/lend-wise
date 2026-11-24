' Double-click to stop the background Lend-Wise server.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & here & "\stop.mjs""", 0, True
MsgBox "Lend-Wise has been stopped.", 64, "Lend-Wise"
