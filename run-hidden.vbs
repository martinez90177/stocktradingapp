' Runs one command with no visible window and waits for it to finish.
'
' Task Scheduler will always pop a console window for a .cmd action run as
' the interactive logon type; the alternative (LogonType S4U) needs admin
' rights to grant "log on as a batch job", which this machine's account does
' not have. wscript.exe itself never shows a window when the script has no
' Echo/MsgBox, and WshShell.Run's third argument (0 = hidden) keeps the
' launched process's own window from appearing either.
'
'   wscript.exe //B run-hidden.vbs "C:\path\to\script.cmd"
Set shell = CreateObject("WScript.Shell")
shell.Run """" & WScript.Arguments(0) & """", 0, True
