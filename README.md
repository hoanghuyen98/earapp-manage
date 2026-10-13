# EarnApp Manager

Web theo dõi nhiều tài khoản EarnApp: trạng thái máy theo thời gian thực, tổng tiền, lịch sử rút, cảnh báo Telegram và báo cáo lãi lỗ.

## Chức năng

- **Tổng quan:** 4 mục tổng (Lifetime, Số dư hiện tại, Đã rút, Mất do bị khoá), thu nhập hôm nay và tháng này, lệnh rút đang chờ, biểu đồ theo ngày.
- **Tài khoản:** thêm một hoặc nhiều acc bằng cookie; đặt trạng thái Running / Stopped / Banned (tự động hoặc chỉnh tay); ghi chú, nhóm, tìm kiếm, lọc.
  - **Lưu trữ** acc không dùng nữa: web ngừng theo dõi, ẩn khỏi danh sách nhưng vẫn giữ lịch sử và vẫn tính vào các con số tổng. Chỉ **Xoá hẳn** khi muốn bỏ luôn số liệu.
- **Máy (node):**
  - 🟢 Đang chạy
  - 🟡 Online nhưng không ra tiền
  - 🔴 Rớt mạng
  - ⚪ Bị ban
- **Rút tiền:** lịch sử rút và lệnh rút đang chờ của tất cả acc.
- **Báo cáo:** lãi lỗ theo tháng (thu nhập quy đổi VNĐ trừ chi phí), xếp hạng máy và tài khoản.
- **Telegram:**
  - Báo khi máy rớt mạng, máy bị ban, acc bị khoá, cookie hết hạn, có lệnh rút mới hoặc tiền đã về.
  - Báo khi một acc không lấy được dữ liệu nhiều lần liên tiếp (proxy chết, mất mạng…), và báo lại khi hết lỗi.
  - Gửi báo cáo tổng kết mỗi tối.
- **Xuất Excel (CSV)** cho tài khoản, máy và lịch sử rút.
- **Bảo mật:** web có mật khẩu đăng nhập, cookie EarnApp được mã hoá AES-256 khi lưu.
  - Đổi mật khẩu thì các thiết bị khác tự bị đăng xuất. Có nút **Đăng xuất các thiết bị khác** trong Cài đặt.
- **Sao lưu:** Cài đặt → **Tải file sao lưu**: 1 file zip gồm database, khoá giải mã cookie và hướng dẫn khôi phục. Giữ file này kín vì nó truy cập được các acc.
- **Telegram lỗi không mất cảnh báo:** gửi không được thì web giữ lại và gửi lại ở phút sau, kèm ghi chú gửi trễ.

## Chạy trên máy (Windows / Linux)

Cần Node.js 22.13 trở lên.

```bash
npm run setup        # cài thư viện + build giao diện (chỉ chạy lần đầu)
npm start            # mở http://localhost:3000
```

Đăng nhập lần đầu: `admin` / `admin123`, hoặc theo `ADMIN_USER` / `ADMIN_PASSWORD` trong `.env`. Vào **Cài đặt** đổi mật khẩu ngay sau khi đăng nhập.

## Đưa lên VPS bằng Docker

```bash
cp .env.example .env      # sửa ADMIN_PASSWORD và SECRET_KEY
docker compose up -d --build
```

- Dữ liệu nằm trong thư mục `data/`. Chỉ cần sao lưu thư mục này, gồm database và khoá mã hoá.
- Nên đặt web sau Nginx/Caddy có HTTPS. Ví dụ Caddy: `quanly.tenmien.com { reverse_proxy localhost:3000 }`.

## Cách lấy cookie EarnApp

1. Đăng nhập earnapp.com/dashboard.
2. Nhấn F12, chọn tab **Network**, nhấn F5, rồi bấm vào request `money`.
3. Trong **Request Headers**, copy toàn bộ dòng **Cookie**.
4. Dán vào **Tài khoản → Thêm tài khoản**. Muốn thêm nhiều acc thì mỗi dòng một cookie.

> ⚠️ **Không bấm Đăng xuất trên EarnApp** sau khi đã thêm acc, vì cookie sẽ mất hiệu lực. Chỉ cần đóng tab.

## Ghi chú kỹ thuật

- Web dùng API nội bộ của dashboard EarnApp (không chính thức). Chỉ cần cookie `oauth-refresh-token`.
- Mỗi acc có lịch riêng: lấy dữ liệu xong thì hẹn lần tới **ngẫu nhiên 5–10 phút** (chỉnh trong Cài đặt). Mỗi lúc chỉ gọi 1 acc, 2 acc cách nhau ít nhất vài giây, nên các acc được rải đều theo thời gian. Có thể đặt proxy riêng cho từng acc: hỗ trợ `http://`, `https://`, `socks5://`, hoặc dán dạng `host:port:user:pass`. Với SOCKS5 cần ghi rõ `socks5://` ở đầu.
- Thu nhập theo ngày được tính từ chênh lệch `earnings_total` giữa các lần đồng bộ, nên chỉ có số liệu **từ ngày bắt đầu theo dõi**.
- Trạng thái máy:
  - Online: có trong `device_statuses`.
  - Bị ban: thiết bị có trường `banned`.
  - Không ra tiền: online nhưng `earned_total` không tăng quá số giờ cài đặt.
- Chạy test logic cảnh báo: `npm test`.
