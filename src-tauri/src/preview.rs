use std::{collections::BTreeMap, io, net::{Ipv4Addr, SocketAddr}, sync::{Arc, Mutex}, time::Duration};
use http_range::HttpRange;
use tokio::{io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::Semaphore, task::JoinHandle};

use crate::results::{CompletedOutput, OutputRegistry};

const HEADER_LIMIT: usize = 16 * 1024;
const STREAM_CHUNK: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Routes {
    jobs: BTreeMap<String, String>,
    media: BTreeMap<String, String>,
}

pub(crate) struct PreviewServer {
    address: SocketAddr,
    token: String,
    routes: Arc<Mutex<Routes>>,
    registry: Arc<Mutex<OutputRegistry>>,
    task: JoinHandle<()>,
}

fn random_key() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法准备本地预览密钥：{error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl PreviewServer {
    pub(crate) async fn start(registry: Arc<Mutex<OutputRegistry>>) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|error| format!("无法启动本地媒体预览：{error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let token = random_key()?;
        let routes = Arc::new(Mutex::new(Routes::default()));
        let task_registry = registry.clone();
        let task_routes = routes.clone();
        let task_token = token.clone();
        let task = tokio::spawn(async move {
            let permits = Arc::new(Semaphore::new(16));
            // Dropping/aborting the listener task also aborts its live streams.
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    incoming = listener.accept() => {
                        let Ok((stream, peer)) = incoming else { break; };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                        let registry = task_registry.clone();
                        let routes = task_routes.clone();
                        let token = task_token.clone();
                        connections.spawn(async move {
                            let _permit = permit;
                            let _ = serve_connection(stream, address, &token, &routes, &registry).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self { address, token, routes, registry, task })
    }

    pub(crate) fn url_for_job(&self, job_id: &str) -> Result<String, String> {
        self.registry.lock().map_err(|_| "结果记录不可用。")?.resolve(job_id)?;
        let mut routes = self.routes.lock().map_err(|_| "预览记录不可用。")?;
        let key = if let Some(key) = routes.jobs.get(job_id) { key.clone() } else {
            let key = random_key()?;
            routes.jobs.insert(job_id.to_owned(), key.clone());
            routes.media.insert(key.clone(), job_id.to_owned());
            key
        };
        // The URL contains only random keys, never a filename or disk path.
        Ok(format!("http://{}/{}/{}", self.address, self.token, key))
    }
}

impl Drop for PreviewServer {
    fn drop(&mut self) { self.task.abort(); }
}

struct Request {
    method: String,
    target: String,
    host: String,
    range: Option<String>,
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, ()> {
    let read = async {
        let mut bytes = Vec::with_capacity(2048);
        let mut chunk = [0_u8; 1024];
        loop {
            let count = stream.read(&mut chunk).await.map_err(|_| ())?;
            if count == 0 { return Err(()); }
            bytes.extend_from_slice(&chunk[..count]);
            if bytes.len() > HEADER_LIMIT { return Err(()); }
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let text = std::str::from_utf8(&bytes[..end]).map_err(|_| ())?;
                let mut lines = text.split("\r\n");
                let first = lines.next().ok_or(())?.split_ascii_whitespace().collect::<Vec<_>>();
                if first.len() != 3 || !matches!(first[2], "HTTP/1.1" | "HTTP/1.0") { return Err(()); }
                let mut host = None;
                let mut range = None;
                for line in lines {
                    if line.bytes().any(|byte| byte < 32 && byte != b'\t') { return Err(()); }
                    let (name, value) = line.split_once(':').ok_or(())?;
                    let value = value.trim();
                    if name.eq_ignore_ascii_case("host") {
                        if host.replace(value.to_owned()).is_some() { return Err(()); }
                    } else if name.eq_ignore_ascii_case("range") {
                        if range.replace(value.to_owned()).is_some() { return Err(()); }
                    }
                }
                return Ok(Request { method: first[0].to_owned(), target: first[1].to_owned(), host: host.ok_or(())?, range });
            }
        }
    };
    tokio::time::timeout(READ_TIMEOUT, read).await.map_err(|_| ())?
}

fn secure_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.bytes().zip(right.bytes()).fold(0_u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

fn locate_output(target: &str, token: &str, routes: &Mutex<Routes>, registry: &Mutex<OutputRegistry>) -> Result<CompletedOutput, u16> {
    let segments = target.split('/').collect::<Vec<_>>();
    if segments.len() != 3 || !segments[0].is_empty() || !secure_equal(segments[1], token) { return Err(404); }
    if segments[2].len() != 64 || !segments[2].bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(404); }
    let job_id = routes.lock().map_err(|_| 500_u16)?.media.get(segments[2]).cloned().ok_or(404_u16)?;
    registry.lock().map_err(|_| 500_u16)?.resolve(&job_id).map_err(|_| 410)
}

fn media_type(output: &CompletedOutput) -> &'static str {
    match output.path.extension().and_then(|extension| extension.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "m4a" => "audio/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "aac" => "audio/aac",
        "ts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}

async fn write_bytes(stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    tokio::time::timeout(WRITE_TIMEOUT, stream.write_all(bytes)).await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "preview response write timeout"))?
}

async fn error_response(stream: &mut TcpStream, status: u16, size: Option<u64>) -> io::Result<()> {
    let reason = match status { 400 => "Bad Request", 403 => "Forbidden", 404 => "Not Found", 405 => "Method Not Allowed", 410 => "Gone", 416 => "Range Not Satisfiable", _ => "Internal Server Error" };
    let mut headers = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n");
    if status == 405 { headers.push_str("Allow: GET, HEAD\r\n"); }
    if let Some(size) = size { headers.push_str(&format!("Content-Range: bytes */{size}\r\nAccept-Ranges: bytes\r\n")); }
    headers.push_str("\r\n");
    write_bytes(stream, headers.as_bytes()).await
}

async fn stream_range(stream: &mut TcpStream, file: &mut tokio::fs::File, range: HttpRange) -> io::Result<()> {
    file.seek(io::SeekFrom::Start(range.start)).await?;
    let mut remaining = range.length;
    let mut buffer = [0_u8; STREAM_CHUNK];
    while remaining > 0 {
        let wanted = remaining.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..wanted]).await?;
        if count == 0 { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "preview file changed while streaming")); }
        write_bytes(stream, &buffer[..count]).await?;
        remaining -= count as u64;
    }
    Ok(())
}

async fn serve_connection(mut stream: TcpStream, address: SocketAddr, token: &str, routes: &Mutex<Routes>, registry: &Mutex<OutputRegistry>) -> io::Result<()> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(_) => return error_response(&mut stream, 400, None).await,
    };
    // Reject alternate hostnames/DNS rebinding, even though the listener is
    // restricted to the IPv4 loopback interface.
    if request.host != address.to_string() { return error_response(&mut stream, 403, None).await; }
    if !matches!(request.method.as_str(), "GET" | "HEAD") { return error_response(&mut stream, 405, None).await; }
    let output = match locate_output(&request.target, token, routes, registry) {
        Ok(output) => output,
        Err(status) => return error_response(&mut stream, status, None).await,
    };
    let mut file = match tokio::fs::File::open(&output.path).await {
        Ok(file) => file,
        Err(_) => return error_response(&mut stream, 410, None).await,
    };
    // Also verify the opened handle, closing a rename/replacement race between
    // the registry check and the file open.
    if !file.metadata().await.is_ok_and(|metadata| output.matches_metadata(&metadata)) {
        return error_response(&mut stream, 410, None).await;
    }
    let size = output.size_bytes;
    let ranges = if request.method == "HEAD" { None } else if let Some(range) = request.range {
        match HttpRange::parse(&range, size) {
            Ok(ranges) if !ranges.is_empty() && ranges.len() <= 16 && ranges.iter().all(|range| range.length > 0) => Some(ranges),
            _ => return error_response(&mut stream, 416, Some(size)).await,
        }
    } else { None };
    let mime = media_type(&output);
    let common = "Accept-Ranges: bytes\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n";
    match ranges {
        None => {
            write_bytes(&mut stream, format!("HTTP/1.1 200 OK\r\n{common}Content-Type: {mime}\r\nContent-Length: {size}\r\n\r\n").as_bytes()).await?;
            if request.method != "HEAD" { stream_range(&mut stream, &mut file, HttpRange { start: 0, length: size }).await?; }
        }
        Some(ranges) if ranges.len() == 1 => {
            let range = ranges[0];
            let end = range.start + range.length - 1;
            write_bytes(&mut stream, format!("HTTP/1.1 206 Partial Content\r\n{common}Content-Type: {mime}\r\nContent-Length: {}\r\nContent-Range: bytes {}-{end}/{size}\r\n\r\n", range.length, range.start).as_bytes()).await?;
            // Honor the complete requested range; bounded streaming chunks are
            // independent of its length, including multi-gigabyte media.
            stream_range(&mut stream, &mut file, range).await?;
        }
        Some(ranges) => {
            let boundary = "ffmpeg_workbench_media_boundary";
            let parts = ranges.iter().map(|range| format!("--{boundary}\r\nContent-Type: {mime}\r\nContent-Range: bytes {}-{}/{size}\r\n\r\n", range.start, range.start + range.length - 1)).collect::<Vec<_>>();
            let closer = format!("--{boundary}--\r\n");
            let length = ranges.iter().zip(&parts).try_fold(closer.len() as u64, |total, (range, header)| total.checked_add(header.len() as u64)?.checked_add(range.length)?.checked_add(2));
            let Some(length) = length else { return error_response(&mut stream, 416, Some(size)).await; };
            write_bytes(&mut stream, format!("HTTP/1.1 206 Partial Content\r\n{common}Content-Type: multipart/byteranges; boundary={boundary}\r\nContent-Length: {length}\r\n\r\n").as_bytes()).await?;
            for (range, header) in ranges.into_iter().zip(parts) {
                write_bytes(&mut stream, header.as_bytes()).await?;
                stream_range(&mut stream, &mut file, range).await?;
                write_bytes(&mut stream, b"\r\n").await?;
            }
            write_bytes(&mut stream, closer.as_bytes()).await?;
        }
    }
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    async fn response(server: &PreviewServer, target: &str, method: &str, headers: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(server.address).await.unwrap();
        stream.write_all(format!("{method} {target} HTTP/1.1\r\nHost: {}\r\n{headers}\r\n", server.address).as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes)).await.unwrap().unwrap();
        let end = bytes.windows(4).position(|part| part == b"\r\n\r\n").unwrap() + 4;
        (String::from_utf8(bytes[..end].to_vec()).unwrap(), bytes[end..].to_vec())
    }

    async fn fixture() -> (tempfile::TempDir, PreviewServer, String, Vec<u8>) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("实际结果 含空格 #1.mp4");
        let bytes = (0..3_000_000).map(|index| (index % 251) as u8).collect::<Vec<_>>();
        fs::write(&path, &bytes).unwrap();
        let mut registry = OutputRegistry::default();
        registry.insert("successful-job".into(), CompletedOutput::new(path.canonicalize().unwrap(), &fs::metadata(&path).unwrap()));
        let server = PreviewServer::start(Arc::new(Mutex::new(registry))).await.unwrap();
        let url = server.url_for_job("successful-job").unwrap();
        let target = url.strip_prefix(&format!("http://{}", server.address)).unwrap().to_owned();
        (directory, server, target, bytes)
    }

    #[tokio::test]
    async fn http_preview_streams_full_head_large_open_suffix_and_multipart_ranges() {
        let (_directory, server, target, bytes) = fixture().await;
        assert_eq!(server.address.ip(), Ipv4Addr::LOCALHOST);
        assert!(!target.contains("mp4") && !target.contains("%") && !target.contains("successful-job"));
        assert_eq!(server.url_for_job("successful-job").unwrap(), format!("http://{}{target}", server.address));
        let (headers, body) = response(&server, &target, "GET", "").await;
        assert!(headers.starts_with("HTTP/1.1 200") && headers.contains("Content-Type: video/mp4") && headers.contains("Content-Length: 3000000") && headers.contains("Accept-Ranges: bytes"));
        assert_eq!(body, bytes);
        let (headers, body) = response(&server, &target, "HEAD", "Range: bytes=0-1\r\n").await;
        assert!(headers.starts_with("HTTP/1.1 200") && headers.contains("Content-Length: 3000000"));
        assert!(body.is_empty());
        for (range, start, end) in [("bytes=0-1", 0, 2), ("bytes=1000000-2200000", 1_000_000, 2_200_001), ("bytes=2800000-", 2_800_000, 3_000_000), ("bytes=-512", 2_999_488, 3_000_000)] {
            let (headers, body) = response(&server, &target, "GET", &format!("Range: {range}\r\n")).await;
            assert!(headers.starts_with("HTTP/1.1 206"));
            assert!(headers.contains(&format!("Content-Range: bytes {start}-{}/3000000", end - 1)));
            assert_eq!(body, bytes[start..end]);
        }
        let (headers, body) = response(&server, &target, "GET", "Range: bytes=0-1,2999998-2999999\r\n").await;
        assert!(headers.starts_with("HTTP/1.1 206") && headers.contains("multipart/byteranges"));
        let expected_length = headers.lines().find_map(|line| line.strip_prefix("Content-Length: ")).unwrap().parse::<usize>().unwrap();
        assert_eq!(body.len(), expected_length);
        assert!(body.windows(2).any(|part| part == &bytes[..2]));
        assert!(body.windows(2).any(|part| part == &bytes[2_999_998..]));
        for range in ["bytes=3000000-", "bytes=12-1", "bytes=-0", "bytes=", "bytes=18446744073709551616-"] {
            let (headers, body) = response(&server, &target, "GET", &format!("Range: {range}\r\n")).await;
            assert!(headers.starts_with("HTTP/1.1 416") && headers.contains("Content-Range: bytes */3000000"), "{headers}");
            assert!(body.is_empty());
        }
    }

    #[tokio::test]
    async fn http_preview_rejects_unknown_jobs_tokens_paths_methods_hosts_and_replacements() {
        let (directory, server, target, _) = fixture().await;
        assert!(server.url_for_job("queued").is_err());
        for forbidden in ["/etc/passwd".to_owned(), target.replace(&server.token, &"0".repeat(64)), format!("/{}/{}", server.token, "0".repeat(64)), format!("{target}/../private.mp4"), format!("{target}?path=/etc/passwd")] {
            let (headers, body) = response(&server, &forbidden, "GET", "").await;
            assert!(headers.starts_with("HTTP/1.1 404"));
            assert!(body.is_empty());
        }
        for method in ["POST", "OPTIONS", "PUT", "DELETE"] {
            assert!(response(&server, &target, method, "").await.0.starts_with("HTTP/1.1 405"));
        }
        let mut stream = TcpStream::connect(server.address).await.unwrap();
        stream.write_all(format!("GET {target} HTTP/1.1\r\nHost: attacker.example\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 403"));
        let path = directory.path().join("实际结果 含空格 #1.mp4");
        fs::write(&path, b"changed result").unwrap();
        assert!(super::tests::response(&server, &target, "GET", "").await.0.starts_with("HTTP/1.1 410"));
        fs::remove_file(&path).unwrap();
        assert!(super::tests::response(&server, &target, "HEAD", "").await.0.starts_with("HTTP/1.1 410"));
    }
}
