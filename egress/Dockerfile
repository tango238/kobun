FROM mitmproxy/mitmproxy:latest
COPY addon.py /home/mitmproxy/addon.py
CMD ["mitmdump", "--listen-host", "0.0.0.0", "--listen-port", "8080", "-s", "/home/mitmproxy/addon.py"]
