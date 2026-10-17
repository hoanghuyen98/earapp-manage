# EarnApp Manager

Web theo dõi nhiều acc EarnApp cho khách D2M. Backend Node 22 + Express + node:sqlite (`server/`), giao diện React + Vite + Tailwind (`web/`). Giao diện và tin nhắn đều bằng tiếng Việt.

## Đang chạy thật trên VPS này
- Web chạy bằng systemd, dịch vụ `earnapp`, cổng 6688. Dữ liệu thật trong `data/` (database, `secret.key` để giải mã cookie). Cấu hình trong `.env`.
- Sửa code backend xong: `systemctl restart earnapp`. Sửa giao diện: `npm run build` rồi `systemctl restart earnapp`.
- Xem log: `journalctl -u earnapp -f`.
- KHÔNG chạy thêm `npm start` / `node server/index.js` khi dịch vụ đang chạy. 2 bản chạy cùng lúc sẽ cùng gọi EarnApp và gửi trùng tin Telegram.
- Muốn chạy thử: dùng `DATA_DIR` riêng (bản sao dữ liệu), `PORT` khác, và tắt Telegram trong bản sao.

## Quy tắc
- KHÔNG gửi tin thử / tin mẫu vào nhóm Telegram thật. Xem trước nội dung tin bằng cách in ra màn hình.
- `npm test` chạy test bằng dữ liệu giả, không gọi EarnApp thật.
- Nút rút tiền (POST /api/redeem của EarnApp) rút thật toàn bộ số dư. Không gọi khi test.
- Không đọc, in hay gửi cookie trong `data/` và `.env` ra ngoài.

## Nghiệp vụ Máy → Acc → Node
- Máy (bảng `machines`) = máy thật / VPS chạy nhiều acc. Phải tạo máy trước, thêm acc thì chọn máy.
- Acc trỏ tới máy qua `accounts.group_name` = `machines.name` ('' = chưa gán máy). Mọi thêm/sửa/đổi tên/xoá/chuyển máy đi qua `server/machines.js` để giữ khớp; không ghi thẳng `group_name`.
- Web, Excel và tin Telegram đều xếp theo máy trước, "Chưa gán máy" cuối.

## API EarnApp (không chính thức)
- Base `https://earnapp.com/dashboard/api/`. Gửi nguyên văn cookie khách dán (không lọc: có acc cần cả `brd_sess_id`).
- Rút tiền: POST `redeem` {to, payment_method}, luôn rút toàn bộ số dư. Mức tối thiểu lấy từ `payment_methods` (PayPal/Wise $10, Amazon $50).
- EarnApp tự rút (Auto-redeem) lúc 13:00 giờ VN mỗi ngày nếu acc có cài email nhận tiền.
