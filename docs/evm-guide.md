# Hướng dẫn dev: Index blockchain (EVM) với Indexa

Tài liệu này hướng dẫn đầy đủ cách dùng connector `evm` để index event on-chain. Triết lý: **bạn không viết code engine, không viết logic gọi RPC, không tự xử lý reorg** — chỉ khai báo contract + ABI + event, viết một handler ngắn cho mỗi event, rồi `indexa deploy`.

---

## 1. Vì sao vẫn cần RPC

Index on-chain nghĩa là đọc dữ liệu của chain (block, log/event, transaction). Nguồn chuẩn để đọc là **JSON-RPC** của một node Ethereum. Framework không bỏ được bước này — nó chỉ biến RPC thành **một biến môi trường**, y như database connection string:

```yaml
source:
  type: evm
  rpc: ${RPC_URL}     # dán URL vào là xong
```

RPC URL lấy từ đâu:

| Cách | Ưu | Nhược |
|---|---|---|
| **Provider** (Alchemy, Infura, QuickNode, Ankr, dRPC…) | Dán URL là chạy, có free tier | Rate limit, phụ thuộc bên thứ ba |
| **Tự chạy node** (geth/erigon/reth) | Toàn quyền, không rate limit | Gánh vận hành (ổ cứng, sync, uptime) |

**Lưu ý quan trọng về archive node:** nếu handler của bạn cần đọc *state cũ* (ví dụ gọi `eth_call` tại một block xa trong quá khứ), bạn cần **archive node** hoặc provider hỗ trợ archive. Riêng việc đọc **log/event** (`eth_getLogs`) thì node thường (pruned/full) gần như luôn đủ — và đó là thứ connector `evm` dùng để index. Phần lớn indexer chỉ cần log, nên node thường là đủ.

---

## 2. Quickstart

```bash
npm install
npm install ethers          # connector evm cần ethers để decode ABI
export RPC_URL="https://eth-mainnet.g.alchemy.com/v2/<key>"
indexa deploy --config examples/evm-erc20/indexa.config.yaml
```

Lần đầu chạy sẽ **backfill** từ `startBlock`, sau đó **tail** các block mới. API query có ngay tại `http://localhost:4000`:

```bash
curl "localhost:4000/holders?orderBy=balance&desc=true&limit=10"
curl "localhost:4000/transfers?from=0x..."
```

---

## 3. Cấu hình `source.evm` đầy đủ

```yaml
source:
  type: evm
  rpc: ${RPC_URL}
  confirmations: 12        # số block chờ phía sau head trước khi index (an toàn reorg). Mặc định 12.
  blockBatchSize: 2000     # số block tối đa mỗi lần eth_getLogs. Mặc định 2000.
  reorgWindow: 128         # độ sâu reorg tối đa có thể rollback. Mặc định 128.
  contracts:
    - address: "0xA0b8...eB48"
      abi: ./erc20.abi.json    # đường dẫn (tương đối với file config) hoặc mảng ABI inline
      events: [Transfer]       # event muốn index; bỏ trống = tất cả event trong ABI
      startBlock: 18000000     # block bắt đầu (thường là block deploy contract)
```

Vài điểm cần biết:

- **`blockBatchSize`**: nhiều provider giới hạn số block hoặc số log mỗi `eth_getLogs` (ví dụ một số giới hạn 10k block hoặc trả lỗi khi quá nhiều log). Nếu gặp lỗi "query returned more than N results" hoặc "block range too wide", giảm giá trị này (ví dụ 500).
- **`confirmations`**: đây là tuyến phòng thủ reorg **chính**. Bằng cách không index trong vòng N block tính từ head, bạn tránh được gần như mọi reorg (vốn thường sâu 1–2 block). Mainnet Ethereum dùng 12 là phổ biến; chain có thời gian finality khác (L2, BSC, Polygon) thì điều chỉnh.
- **`reorgWindow`**: dự phòng cho reorg sâu hơn `confirmations` (hiếm). Connector giữ block hash trong cửa sổ này để có thể lần ngược tìm điểm rollback.

Nhiều contract / nhiều event: cứ thêm vào danh sách `contracts`. Các event **cùng tên** (ví dụ `Transfer` từ nhiều token) sẽ gộp vào **một stream** tên `Transfer`, và handler `Transfer` của bạn nhận tất cả — phân biệt bằng `event.address`.

---

## 4. Viết handler cho event

Mỗi event là một **stream** mang đúng tên event. Handler là một hàm `async (event, ctx)`. Indexa đã decode log sẵn, bạn nhận object:

```js
event = {
  id:          "0x<txHash>-<logIndex>",  // id tự nhiên, duy nhất cho mỗi log
  event:       "Transfer",
  address:     "0x...",                   // contract phát ra event (đã lowercase)
  blockNumber: 18000123,
  blockHash:   "0x...",
  txHash:      "0x...",
  logIndex:    7,
  args:        { from: "0x...", to: "0x...", value: "1000000" }, // tham số đã decode
}
```

`args` chứa tham số theo tên trong ABI. Số nguyên lớn (uint256) được trả về dưới dạng **string** để không mất chính xác — convert sang `BigInt` khi cần tính toán.

Ví dụ handler vừa lưu event vừa duy trì số dư holder (xem `examples/evm-erc20/handlers.js`):

```js
export default {
  async Transfer(event, ctx) {
    const { from, to, value } = event.args;

    await ctx.store.upsert('Transfer', event.id, {
      id: event.id, from, to, value: String(value),
      blockNumber: event.blockNumber, txHash: event.txHash,
    });

    const v = BigInt(value);
    await adjust(ctx, from, -v);   // read-modify-write
    await adjust(ctx, to,   +v);
  },
};

async function adjust(ctx, addr, delta) {
  const h = await ctx.store.get('Holder', addr);
  const prev = h ? BigInt(h.balance) : 0n;
  await ctx.store.upsert('Holder', addr, {
    id: addr, address: addr,
    balance: (prev + delta).toString(),
    transferCount: (h ? h.transferCount : 0) + 1,
  });
}
```

Sinh kiểu TypeScript cho handler:

```bash
indexa types --config examples/evm-erc20/indexa.config.yaml
# -> tạo indexa-types.d.ts (autocomplete cho entity + ctx.store)
```

---

## 5. Reorg được xử lý thế nào (và đảm bảo gì)

Đây là phần khác biệt lớn nhất so với index DB thường, và là lý do nên dùng framework thay vì tự code.

**Cursor = block number.** Engine ghi checkpoint là block đã index xong; khởi động lại là tiếp đúng chỗ.

**Cơ chế phát hiện reorg.** Connector lưu block hash của các block gần head (trong `reorgWindow`). Mỗi lần poll, trước khi đọc block mới, nó kiểm tra: hash của block tip đã index trước đó **có còn khớp** với hash canonical hiện tại không?
- Khớp → không reorg, index tiếp.
- Lệch → có reorg. Connector lần ngược các block hash đã lưu để tìm **tổ tiên chung** (block cuối cùng còn khớp), rồi báo engine rollback về đó.

**Undo journal (điểm mấu chốt).** Mỗi lần handler `upsert` trong lúc index một block chưa finalize, store ghi lại **giá trị cũ** của bản ghi vào một journal gắn với block đó. Khi rollback về block N:
- Mọi bản ghi được ghi ở block > N được **hoàn nguyên** (insert mới → xóa; update → trả lại giá trị cũ).
- Nhờ vậy, **kể cả aggregate** (như số dư cộng dồn) cũng được sửa đúng — không chỉ xóa row theo block.

Sau đó engine reindex chain canonical mới từ tổ tiên chung. Toàn bộ rollback + reindex nằm trong transaction, nên không bao giờ để lại trạng thái nửa vời.

**Đảm bảo:**
- Không double-write, không skip: checkpoint advance commit **chung transaction** với entity writes.
- Reorg trong phạm vi `reorgWindow` được rollback chính xác, kể cả aggregate.
- Block đã finalize (cách head hơn `confirmations`, ngoài `reorgWindow`) được prune khỏi journal để journal không phình.

**Giới hạn (cần biết):**
- Reorg **sâu hơn `reorgWindow`** không rollback được (đây là điều gần như không xảy ra trên mainnet, nhưng hãy đặt `reorgWindow` đủ lớn cho chain của bạn).
- Connector hiện **poll** theo `pollIntervalMs`; độ trễ tail ≈ interval + `confirmations` block. Cần realtime hơn thì viết transport push-based (mục 8).
- Nếu handler gọi RPC ngoài (ví dụ `eth_call` đọc state) thì giá trị đó cũng phụ thuộc block; thiết kế để đọc tại `event.blockNumber` nếu cần tính nhất quán.

**Bằng chứng nó chạy:** chạy test reorg (mock RPC dựng kịch bản reorg ở block 108):

```bash
node test/reorg.test.mjs
# ✅ orphaned writes undone, new chain indexed, balances corrected.
```

![Test reorg pass](images/reorg-test.png)

---

## 6. Backfill lịch sử sâu

Lần đầu, connector quét từ `startBlock` đến `head - confirmations` theo từng lô `blockBatchSize`. Với contract lâu đời (hàng triệu block), việc này tốn thời gian và nhiều request `eth_getLogs`. Mẹo:

- Đặt `startBlock` đúng = block deploy contract (đừng để 0).
- Tăng `blockBatchSize` nếu provider cho phép; giảm nếu bị giới hạn số log.
- Provider trả lỗi range/log-limit → giảm `blockBatchSize`.
- Cần đọc state cũ trong handler → dùng archive node/provider archive.

---

## 7. Triển khai

Docker (đã kèm `Dockerfile`):

```bash
# đặt config + handlers + abi vào ./app
docker build -t my-evm-indexer .
docker run -p 4000:4000 \
  -e RPC_URL="https://..." \
  -e CONFIG=app/indexa.config.yaml \
  my-evm-indexer
```

Image có healthcheck `/_health` và đọc `INDEXA_LOG_LEVEL`. Target nên dùng Postgres cho production:

```yaml
target:
  type: postgres
  connection: ${DB_URL}     # cần: npm install pg
```

---

## 8. Mở rộng

**Tự viết connector** (ví dụ Firehose/Substreams, Kafka, một chain non-EVM): implement `init / streams / close` (xem `src/connectors/base.js` và `examples/custom-connector/`). Stream nào có thể reorg thì đặt `reorgAware: true` và trả `reorg: { toCursor }` khi phát hiện — engine lo phần rollback bằng journal. Đăng ký:

```js
import { registerConnector } from 'indexa';
import FirehoseConnector from './firehose.js';
registerConnector('firehose', FirehoseConnector);
```

**Inject transport** (test hoặc dùng provider SDK riêng): truyền `source.transport = async (method, params) => result` để bỏ qua HTTP mặc định — đây chính là cách `test/reorg.test.mjs` mô phỏng cả một chain có reorg mà không cần node thật.

**Custom target:** implement cùng interface như `src/store.js` (`init/upsert/get/query/checkpoint/transaction/kv/journal`) rồi nối vào `createStore`.

---

## 9. Checklist vận hành

- [ ] `startBlock` = block deploy contract.
- [ ] `confirmations` hợp với finality của chain (mainnet ~12; L2/sidechain điều chỉnh).
- [ ] `reorgWindow` ≥ độ sâu reorg tệ nhất bạn muốn chịu được.
- [ ] `blockBatchSize` không vượt giới hạn provider.
- [ ] Target = Postgres cho production; bật backup.
- [ ] Theo dõi log `reorg detected — rolled back` để biết tần suất reorg thực tế.
- [ ] Nếu cần đọc state cũ trong handler → dùng archive node.
