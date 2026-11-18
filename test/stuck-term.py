#!/usr/bin/env python3
"""SIGTERM while the terminal is not reading output: ultrawatch must still exit promptly and leave the tty cooked.
A shell is the session leader (as in a real terminal); ultrawatch runs as its child.
usage: stuck-term.py <ultrawatch.mjs> <fixtures root> <pidfile>; prints JSON {exited, secs, icanon, echo}"""
import os, sys, pty, time, json, signal, termios, struct, fcntl, shlex
uw, root, pidfile = sys.argv[1], sys.argv[2], sys.argv[3]
mfd, sfd = pty.openpty()
fcntl.ioctl(sfd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
try: os.unlink(pidfile)
except FileNotFoundError: pass
sh = os.fork()
if sh == 0:
    os.setsid(); os.close(mfd)
    fcntl.ioctl(sfd, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2): os.dup2(sfd, fd)
    env = dict(os.environ); env.pop('ULTRAWATCH_NOW', None); env['TERM'] = 'xterm-256color'
    cmd = 'exec 3<&0; node %s --root %s --run run0 --interval 50 <&3 & echo $! > %s; wait; sleep 20' % (shlex.quote(uw), shlex.quote(root), shlex.quote(pidfile))
    os.execvpe('sh', ['sh', '-c', cmd], env)
pid = None
for _ in range(100):
    try: pid = int(open(pidfile).read().strip()); break
    except Exception: time.sleep(0.05)
import select
buf = b''; end = time.time() + 30  # read normally until the TUI has drawn a frame (it is in raw mode by then) ...
while time.time() < end and b'demo-running' not in buf:
    r, _, _ = select.select([mfd], [], [], 0.05)
    if r: buf += os.read(mfd, 1 << 16)
end = time.time() + 0.5
while time.time() < end:
    r, _, _ = select.select([mfd], [], [], 0.05)
    if r: os.read(mfd, 1 << 16)
time.sleep(5)  # ... then stop reading: the pty buffer fills up and output stalls
os.kill(pid, signal.SIGTERM)
t0 = time.time(); exited = False
while time.time() - t0 < 4:
    try: os.kill(pid, 0)
    except ProcessLookupError: exited = True; break
    if os.popen('ps -o stat= -p %d' % pid).read().strip().startswith('Z'): exited = True; break
    time.sleep(0.05)
secs = round(time.time() - t0, 2)
if not exited:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
a = termios.tcgetattr(sfd)
os.kill(sh, signal.SIGKILL); os.close(mfd)
try: os.waitpid(sh, 0)
except Exception: pass
print(json.dumps({'exited': exited, 'secs': secs, 'icanon': bool(a[3] & termios.ICANON), 'echo': bool(a[3] & termios.ECHO)}))
