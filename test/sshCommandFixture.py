"""Loopback-only SSH fixture. Implements fixed probes, never executes shell input."""
import logging
import os
import shlex
import socket
import threading
import time

import paramiko

logging.getLogger("paramiko").setLevel(logging.CRITICAL)
key = paramiko.RSAKey.generate(2048)


def attributes(data):
    result = paramiko.SFTPAttributes()
    result.st_size = len(data)
    result.st_mode = 0o100600
    result.st_mtime = result.st_atime = 1
    return result


class MemoryHandle(paramiko.SFTPHandle):
    def __init__(self, data, flags):
        super().__init__(flags)
        self.data = data

    def read(self, offset, length):
        return bytes(self.data[offset:offset + length])

    def write(self, offset, data):
        self.data[offset:offset + len(data)] = data
        return paramiko.SFTP_OK

    def stat(self):
        return attributes(self.data)


class MemoryFiles(paramiko.SFTPServerInterface):
    def __init__(self, server, files):
        super().__init__(server)
        self.files = files

    def stat(self, path):
        return attributes(self.files[path]) if path in self.files else paramiko.SFTP_NO_SUCH_FILE

    lstat = stat

    def open(self, path, flags, attr):
        if flags & os.O_CREAT:
            if flags & os.O_EXCL and path in self.files:
                return paramiko.SFTP_FAILURE
            self.files.setdefault(path, bytearray())
        if path not in self.files:
            return paramiko.SFTP_NO_SUCH_FILE
        if flags & os.O_TRUNC:
            self.files[path].clear()
        return MemoryHandle(self.files[path], flags)

    def rename(self, old, new):
        # OpenSSH's ordinary SFTP v3 rename does not overwrite an existing file.
        if old not in self.files or new in self.files:
            return paramiko.SFTP_FAILURE
        self.files[new] = self.files.pop(old)
        return paramiko.SFTP_OK


class Probes(paramiko.ServerInterface):
    def __init__(self, files):
        self.files = files

    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ("test", "fixture-only") else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        def reply():
            try:
                if command == b"large-stderr":
                    channel.sendall_stderr(b"e" * (3 * 1024 * 1024))
                    channel.sendall(b"stdout-after-stderr")
                elif command == b"stall":
                    time.sleep(10)
                elif command.startswith(b"mv -fT -- "):
                    args = shlex.split(command.decode())
                    if len(args) != 5 or args[3] not in self.files:
                        channel.send_exit_status(1)
                        return
                    self.files[args[4]] = self.files.pop(args[3])
                else:
                    channel.send_exit_status(127)
                    return
                channel.send_exit_status(0)
            except (OSError, EOFError):
                pass
            finally:
                channel.close()
        threading.Thread(target=reply, daemon=True).start()
        return True


def serve(client):
    transport = paramiko.Transport(client)
    transport.add_server_key(key)
    files = {}
    transport.set_subsystem_handler("sftp", paramiko.SFTPServer, MemoryFiles, files=files)
    try:
        transport.start_server(server=Probes(files))
        channels = []
        while transport.is_active():
            channel = transport.accept(1)
            if channel is not None:
                channels.append(channel)
    except (OSError, EOFError, paramiko.SSHException):
        pass
    finally:
        transport.close()


with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    print(listener.getsockname()[1], flush=True)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client,), daemon=True).start()
