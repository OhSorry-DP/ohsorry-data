// users-list-slim.mjs — users-list.json 을 v3 검색용 4키로 projection 한다.
//
// 🔴 공유 모듈로 둔 이유 — 이 계약의 **세 번째 중복**이기 때문이다. 같은 구조의 중복
//   (dumpUser 스키마 이중 구현)이 과거 **persona 37명 유실 사고**를 냈다(CHANGELOG.md 2026-08-04).
//   여기서는 dump-users-list(전체 재생성)와 merge-user-into-list(증분 병합) 둘이 이것을 쓴다.
// ⚠️ ohSorryAdmin/scripts/dump-data-repo.js 의 dumpUsersListSlim() 과 **같은 계약**이지만
//   그쪽은 다른 레포라 import 할 수 없다 — 계약을 바꾸면 그쪽도 같이 고쳐야 한다.
//
// 계약: [{ iidx_id, dj_name, star, r_star }] — star/r_star 는 없으면 null.

export function toSlim(list) {
  // 🔴 빈 목록을 산출하면 그대로 R2 에 올라가 전 유저 검색이 날아간다.
  //   §4 이후 R2 가 유일본이라 되돌릴 수 없다(merge-user-into-list.mjs 의 같은 가드와 같은 이유).
  if (!Array.isArray(list) || !list.length) {
    throw new Error('users-list 베이스가 없거나 비었다'
      + ' — 빈 목록을 슬림으로 만들면 전 유저 검색이 사라진다. 원본 취득 실패를 먼저 확인할 것');
  }

  return list.map((u) => ({
    iidx_id: u.iidx_id,
    dj_name: u.dj_name,
    star: u.star ?? null,
    r_star: u.r_star ?? null,
  }));
}
