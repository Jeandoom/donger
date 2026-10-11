@echo off
rem donger Docker 栈每日备份（任务计划程序 donger-docker-backup 调用）
"C:\Program Files\Git\bin\bash.exe" -c "cd /d/code/donger && scripts/docker-backup.sh"
