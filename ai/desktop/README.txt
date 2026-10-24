MINDOVERMATTER / LM STUDIO SHARING FOR WINDOWS
=============================================

1. Extract the whole ZIP into a folder. Do not run inside the ZIP preview.
2. Open LM Studio, load a chat model, then open Developer and start the
   local server on port 1234. Leave Serve on Local Network and CORS OFF.
3. Double-click Start-LM-Share.cmd. First launch downloads the current
   Node.js LTS Windows x64 runtime and cloudflared from official releases.
   Both downloads are verified with the vendor's SHA256 checksums.
   No administrator access, router forwarding, or Cloudflare account needed.
4. If LM Studio requires authentication, paste its API token when asked
   in the Windows console. It is hidden while typing and is not saved.
5. The window prints a PRIVATE ACCESS KEY and YOUR CHAT LINK.
   The browser opens the link. Paste the private key and click Connect.
6. Give friends the chat link and private access key through a private
   channel. Keep your desktop awake, LM Studio running, and this window open.
7. Close the window or press Ctrl+C to stop sharing.

Full illustrated-by-steps setup and troubleshooting:
https://mindovermatter.space/ai/setup.html

IMPORTANT
---------
- Every restart creates a NEW temporary address. Share the new chat link.
- The private access key stays the same between restarts. To replace it,
  close the running sharing window and run Reset-Access-Key.cmd.
- Your LM Studio API token and the private sharing key are DIFFERENT.
  Only the sharing key should be given to friends.
- The relay listens only on 127.0.0.1:8787. LM Studio stays on localhost.
- One generation runs at a time; four more may wait. A reply is limited
  to 2,048 tokens and ten minutes. Abandoned requests stop after 90 seconds.
- Chat history and replies stay in memory. The relay does not write chat
  logs; LM Studio may log requests. The host can see requests in LM Studio.
- Chat passes through Cloudflare. HTTPS terminates there; this is not
  end-to-end encryption. Quick Tunnels have no uptime guarantee.
- Tools and per-request MCP access are not forwarded. Only text chat and
  model listing are exposed, not files, shell, or model management.
- Runtime files and access-key.txt live in:
  %LOCALAPPDATA%\MindOverMatterLLM
- PowerShell's execution policy override applies only to this launcher
  process. It does not change your system's persistent execution policy.
- Standard Intel/AMD 64-bit Windows is supported. ARM Windows requires
  Windows' x64 emulation support. 32-bit Windows is not supported.

OPTIONAL ADVANCED CONFIGURATION
------------------------------
MOM_LM_URL: loopback HTTP origin, default http://127.0.0.1:1234
MOM_LM_TOKEN: LM Studio API token; normally entered at the hidden prompt.
The relay intentionally rejects non-local upstream addresses.

Review the source at:
https://github.com/voidicebreaker/Nexus/tree/main/ai/desktop
