// Local wall-clock time, for log lines and backup names. No date crate needed:
// each OS already knows the local time zone.

/// (year, month, day, hour, minute, second) in local time.
#[cfg(windows)]
pub fn local_now() -> (u32, u32, u32, u32, u32, u32) {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    (
        t.wYear as u32,
        t.wMonth as u32,
        t.wDay as u32,
        t.wHour as u32,
        t.wMinute as u32,
        t.wSecond as u32,
    )
}

/// (year, month, day, hour, minute, second) in local time.
#[cfg(unix)]
pub fn local_now() -> (u32, u32, u32, u32, u32, u32) {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        (
            (tm.tm_year + 1900) as u32,
            (tm.tm_mon + 1) as u32,
            tm.tm_mday as u32,
            tm.tm_hour as u32,
            tm.tm_min as u32,
            tm.tm_sec as u32,
        )
    }
}
