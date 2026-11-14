package fe.local;

import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 群聊：建群、成员、管理员、禁言、群名片、公告、群文件、邀请。 */
final class Groups {
  private final Api api;
  private final Store store;
  private final File dataDir;

  Groups(Api api, Store store, File dataDir) {
    this.api = api;
    this.store = store;
    this.dataDir = dataDir;
  }

  void register(final Http http) {
    http.route("POST", "/api/groups", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> b = req.json();
        String name = String.valueOf(b.get("name") == null ? "" : b.get("name")).trim();
        if (name.isEmpty() || name.length() > 24) { res.error(400, "群名 1–24 个字"); return; }
        String number = String.valueOf(b.get("number") == null ? "" : b.get("number")).trim();
        if (number.isEmpty()) number = String.valueOf(600000 + (System.currentTimeMillis() % 300000));
        if (!number.matches("^[1-9][0-9]{4,11}$")) { res.error(400, "群号必须是 5–12 位数字"); return; }
        if (api.findOne("groups", "number", number) != null) { res.error(409, "这个群号已经被用了"); return; }
        Map<String, Object> conv = new LinkedHashMap<String, Object>();
        long convId = api.nextIdOf("conversations");
        conv.put("id", convId);
        conv.put("kind", "group");
        conv.put("created_at", System.currentTimeMillis());
        api.insertRow("conversations", conv);
        Map<String, Object> g = new LinkedHashMap<String, Object>();
        long gid = api.nextIdOf("groups");
        g.put("id", gid);
        g.put("number", number);
        g.put("name", name);
        g.put("owner_id", api.idOf(me));
        g.put("created_at", System.currentTimeMillis());
        g.put("announcement", "");
        g.put("conversation_id", convId);
        g.put("mute_all", 0);
        g.put("announcement_updated_at", 0);
        api.insertRow("groups", g);
        api.addMemberTo(convId, api.idOf(me));
        addGroupMember(gid, api.idOf(me), "owner");
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("group", api.groupBriefOf(g));
        res.json(out);
      }
    });

    http.route("GET", "/api/groups", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        List<Object> out = new ArrayList<Object>();
        for (Map<String, Object> gm : api.findAll("group_members", "account_id", api.idOf(me))) {
          Map<String, Object> g = api.findOne("groups", "id", api.numOf(gm, "group_id"));
          if (g == null) continue;
          Map<String, Object> item = api.groupBriefOf(g);
          item.put("role", api.strOf(gm, "role"));
          item.put("members", api.findAll("group_members", "group_id", api.idOf(g)).size());
          out.add(item);
        }
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("groups", out);
        res.json(payload);
      }
    });

    http.route("GET", "/api/groups/:number", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        long gid = api.idOf(g);
        Map<String, Object> gm = groupMember(gid, api.idOf(me));
        if (gm == null) { res.error(403, "你不在这个群里"); return; }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Map<String, Object> info = api.groupBriefOf(g);
        info.put("role", api.strOf(gm, "role"));
        info.put("members", api.findAll("group_members", "group_id", gid).size());
        info.put("my_nickname", api.strOf(gm, "nickname"));
        info.put("my_mute_until", api.numOf(gm, "mute_until"));
        info.put("announcement_read_at", api.numOf(gm, "announcement_read_at"));
        out.put("group", info);
        res.json(out);
      }
    });

    http.route("GET", "/api/groups/:number/members", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        long gid = api.idOf(g);
        if (groupMember(gid, api.idOf(me)) == null) { res.error(403, "你不在这个群里"); return; }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("members", membersOf(gid));
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/join", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        long gid = api.idOf(g);
        if (groupMember(gid, api.idOf(me)) != null) { res.error(409, "你已经在这个群里了"); return; }
        api.addMemberTo(api.numOf(g, "conversation_id"), api.idOf(me));
        addGroupMember(gid, api.idOf(me), "member");
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/invite", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        long gid = api.idOf(g);
        if (groupMember(gid, api.idOf(me)) == null) { res.error(403, "你不在这个群里"); return; }
        String number = String.valueOf(req.json().get("number") == null ? "" : req.json().get("number"));
        Map<String, Object> t = api.accountByNumberOf(number);
        if (t == null) { res.error(404, "没有这个号码"); return; }
        if (groupMember(gid, api.idOf(t)) != null) { res.error(409, "对方已经在群里了"); return; }
        Map<String, Object> r = new LinkedHashMap<String, Object>();
        r.put("id", api.nextIdOf("group_requests"));
        r.put("group_id", gid);
        r.put("from_id", api.idOf(me));
        r.put("to_id", api.idOf(t));
        r.put("kind", "invite");
        r.put("status", "pending");
        r.put("created_at", System.currentTimeMillis());
        api.insertRow("group_requests", r);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("pending", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("GET", "/api/group-requests", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        long meId = api.idOf(me);
        List<Object> incoming = new ArrayList<Object>();
        List<Object> outgoing = new ArrayList<Object>();
        for (Map<String, Object> r : api.allRows("group_requests")) {
          if (!"pending".equals(api.strOf(r, "status"))) continue;
          Map<String, Object> g = api.findOne("groups", "id", api.numOf(r, "group_id"));
          if (g == null) continue;
          boolean mine = api.numOf(r, "to_id") == meId;
          boolean sent = api.numOf(r, "from_id") == meId;
          if (!mine && !sent) continue;
          Map<String, Object> a = api.accountOf(api.numOf(r, mine ? "from_id" : "to_id"));
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("id", api.numOf(r, "id"));
          item.put("created_at", api.numOf(r, "created_at"));
          item.put("group_id", api.numOf(r, "group_id"));
          item.put("number", api.strOf(g, "number"));
          item.put("name", api.strOf(g, "name"));
          item.put("from_number", a == null ? "" : api.strOf(a, "number"));
          item.put("from_nickname", a == null ? "" : api.strOf(a, "nickname"));
          item.put("from_avatar", a == null ? "" : api.strOf(a, "avatar"));
          item.put("to_number", a == null ? "" : api.strOf(a, "number"));
          item.put("to_nickname", a == null ? "" : api.strOf(a, "nickname"));
          (mine ? incoming : outgoing).add(item);
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("incoming", incoming);
        out.put("outgoing", outgoing);
        res.json(out);
      }
    });

    http.route("POST", "/api/group-requests/:id/accept", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        resolveRequest(req, res, true);
      }
    });

    http.route("POST", "/api/group-requests/:id/reject", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        resolveRequest(req, res, false);
      }
    });

    http.route("DELETE", "/api/groups/:number/leave", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        long gid = api.idOf(g);
        Map<String, Object> gm = groupMember(gid, api.idOf(me));
        if (gm == null) { res.error(403, "你不在这个群里"); return; }
        if ("owner".equals(api.strOf(gm, "role"))) { res.error(400, "群主不能直接退群，请先解散或转让"); return; }
        api.deleteRow("group_members", gm);
        Map<String, Object> cm = api.memberOfConv(api.numOf(g, "conversation_id"), api.idOf(me));
        if (cm != null) api.deleteRow("members", cm);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/kick", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> ctx = manageContext(req, res, false);
        if (ctx == null) return;
        Map<String, Object> g = Json.obj(ctx.get("group"));
        String role = api.strOf(Json.obj(ctx.get("me")), "role");
        String number = String.valueOf(req.json().get("number") == null ? "" : req.json().get("number"));
        Map<String, Object> t = api.accountByNumberOf(number);
        if (t == null) { res.error(404, "没有这个号码"); return; }
        Map<String, Object> tm = groupMember(api.idOf(g), api.idOf(t));
        if (tm == null) { res.error(404, "对方不在群里"); return; }
        String tr = api.strOf(tm, "role");
        if ("owner".equals(tr)) { res.error(403, "不能踢群主"); return; }
        if ("admin".equals(tr) && !"owner".equals(role)) { res.error(403, "只有群主能踢管理员"); return; }
        api.deleteRow("group_members", tm);
        Map<String, Object> cm = api.memberOfConv(api.numOf(g, "conversation_id"), api.idOf(t));
        if (cm != null) api.deleteRow("members", cm);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/admin", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> ctx = manageContext(req, res, true);
        if (ctx == null) return;
        Map<String, Object> g = Json.obj(ctx.get("group"));
        String number = String.valueOf(req.json().get("number") == null ? "" : req.json().get("number"));
        Map<String, Object> t = api.accountByNumberOf(number);
        if (t == null) { res.error(404, "没有这个号码"); return; }
        Map<String, Object> tm = groupMember(api.idOf(g), api.idOf(t));
        if (tm == null) { res.error(404, "对方不在群里"); return; }
        boolean on = Boolean.TRUE.equals(req.json().get("admin"));
        if ("owner".equals(api.strOf(tm, "role"))) { res.error(403, "群主不用设置"); return; }
        tm.put("role", on ? "admin" : "member");
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/mute", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> ctx = manageContext(req, res, false);
        if (ctx == null) return;
        Map<String, Object> g = Json.obj(ctx.get("group"));
        String myRole = api.strOf(Json.obj(ctx.get("me")), "role");
        String number = String.valueOf(req.json().get("number") == null ? "" : req.json().get("number"));
        Map<String, Object> t = api.accountByNumberOf(number);
        if (t == null) { res.error(404, "没有这个号码"); return; }
        Map<String, Object> tm = groupMember(api.idOf(g), api.idOf(t));
        if (tm == null) { res.error(404, "对方不在群里"); return; }
        String tr = api.strOf(tm, "role");
        if ("owner".equals(tr)) { res.error(403, "不能禁言群主"); return; }
        if ("admin".equals(tr) && !"owner".equals(myRole)) { res.error(403, "只有群主能禁言管理员"); return; }
        long minutes = req.json().get("minutes") instanceof Number ? ((Number) req.json().get("minutes")).longValue() : 0;
        if (minutes < 0 || minutes > 43200) { res.error(400, "禁言时长不对"); return; }
        tm.put("mute_until", minutes == 0 ? 0 : System.currentTimeMillis() + minutes * 60000L);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/mute-all", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> ctx = manageContext(req, res, false);
        if (ctx == null) return;
        Map<String, Object> g = Json.obj(ctx.get("group"));
        boolean on = Boolean.TRUE.equals(req.json().get("muteAll"));
        g.put("mute_all", on ? 1 : 0);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("PATCH", "/api/groups/:number/me", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        Map<String, Object> gm = groupMember(api.idOf(g), api.idOf(me));
        if (gm == null) { res.error(403, "你不在这个群里"); return; }
        String nick = String.valueOf(req.json().get("nickname") == null ? "" : req.json().get("nickname"));
        if (nick.length() > 16) { res.error(400, "群名片最多 16 个字"); return; }
        gm.put("nickname", nick);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("PATCH", "/api/groups/:number", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> ctx = manageContext(req, res, false);
        if (ctx == null) return;
        Map<String, Object> g = Json.obj(ctx.get("group"));
        Map<String, Object> b = req.json();
        if (b.containsKey("name")) {
          String name = String.valueOf(b.get("name")).trim();
          if (name.isEmpty() || name.length() > 24) { res.error(400, "群名 1–24 个字"); return; }
          g.put("name", name);
        }
        if (b.containsKey("announcement")) {
          String text = String.valueOf(b.get("announcement"));
          if (text.length() > 2000) { res.error(400, "公告最多 2000 字"); return; }
          g.put("announcement", text);
          g.put("announcement_updated_at", System.currentTimeMillis());
        }
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/announcement/read", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        Map<String, Object> gm = groupMember(api.idOf(g), api.idOf(me));
        if (gm == null) { res.error(403, "你不在这个群里"); return; }
        gm.put("announcement_read_at", System.currentTimeMillis());
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("GET", "/api/groups/:number/files", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        if (groupMember(api.idOf(g), api.idOf(me)) == null) { res.error(403, "你不在这个群里"); return; }
        List<Object> out = new ArrayList<Object>();
        for (Map<String, Object> f : api.findAll("group_files", "group_id", api.idOf(g))) {
          Map<String, Object> a = api.accountOf(api.numOf(f, "uploader_id"));
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("id", api.numOf(f, "id"));
          item.put("name", api.strOf(f, "name"));
          item.put("url", api.strOf(f, "url"));
          item.put("size", api.numOf(f, "size"));
          item.put("created_at", api.numOf(f, "created_at"));
          item.put("uploader_number", a == null ? "" : api.strOf(a, "number"));
          item.put("uploader_nickname", a == null ? "" : api.strOf(a, "nickname"));
          out.add(item);
        }
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("files", out);
        res.json(payload);
      }
    });

    http.route("POST", "/api/groups/:number/files", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        if (groupMember(api.idOf(g), api.idOf(me)) == null) { res.error(403, "你不在这个群里"); return; }
        Map<String, Object> b = req.json();
        String name = String.valueOf(b.get("name") == null ? "" : b.get("name")).trim();
        String url = String.valueOf(b.get("url") == null ? "" : b.get("url"));
        if (name.isEmpty() || name.length() > 80) { res.error(400, "文件名 1–80 个字"); return; }
        if (!url.startsWith("/uploads/")) { res.error(400, "文件必须先上传"); return; }
        Map<String, Object> f = new LinkedHashMap<String, Object>();
        f.put("id", api.nextIdOf("group_files"));
        f.put("group_id", api.idOf(g));
        f.put("uploader_id", api.idOf(me));
        f.put("name", name);
        f.put("url", url);
        f.put("size", b.get("size") instanceof Number ? ((Number) b.get("size")).longValue() : 0);
        f.put("created_at", System.currentTimeMillis());
        api.insertRow("group_files", f);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("DELETE", "/api/groups/:number/files/:id", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        Map<String, Object> gm = groupMember(api.idOf(g), api.idOf(me));
        if (gm == null) { res.error(403, "你不在这个群里"); return; }
        Map<String, Object> f = api.findOne("group_files", "id", Long.parseLong(req.param("id")));
        if (f == null || api.numOf(f, "group_id") != api.idOf(g)) { res.error(404, "没有这个文件"); return; }
        String role = api.strOf(gm, "role");
        boolean manager = "owner".equals(role) || "admin".equals(role);
        if (api.numOf(f, "uploader_id") != api.idOf(me) && !manager) { res.error(403, "只有上传者或管理员能删"); return; }
        api.deleteRow("group_files", f);
        api.saveAll();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/groups/:number/messages", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
        if (g == null) { res.error(404, "没有这个群"); return; }
        if (groupMember(api.idOf(g), api.idOf(me)) == null) { res.error(403, "你不在这个群里"); return; }
        long convId = api.numOf(g, "conversation_id");
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        String text = String.valueOf(req.json().get("body") == null ? "" : req.json().get("body"));
        data.put("kind", "text");
        data.put("body", text);
        data.put("meta", "");
        data.put("replyTo", 0L);
        Map<String, Object> out = api.insertMsg(me, convId, data);
        if (out.containsKey("error")) {
          Object st = out.get("status");
          res.error(st instanceof Number ? ((Number) st).intValue() : 400, String.valueOf(out.get("error")));
          return;
        }
        api.saveAll();
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("ok", Boolean.TRUE);
        payload.put("message", api.serializeMsg(api.messageById(((Number) out.get("id")).longValue()), api.idOf(me), true));
        res.json(payload);
      }
    });
  }

  private void resolveRequest(Http.Req req, Http.Res res, boolean accept) {
    Map<String, Object> me = api.requireMeOf(req, res);
    if (me == null) return;
    Map<String, Object> r = api.findOne("group_requests", "id", Long.parseLong(req.param("id")));
    if (r == null) { res.error(404, "没有这条邀请"); return; }
    if (api.numOf(r, "to_id") != api.idOf(me)) { res.error(403, "这不是发给你的邀请"); return; }
    if (!"pending".equals(api.strOf(r, "status"))) { res.error(409, "这条邀请已经处理过了"); return; }
    r.put("status", accept ? "accepted" : "rejected");
    if (accept) {
      Map<String, Object> g = api.findOne("groups", "id", api.numOf(r, "group_id"));
      if (g != null) {
        api.addMemberTo(api.numOf(g, "conversation_id"), api.idOf(me));
        addGroupMember(api.idOf(g), api.idOf(me), "member");
      }
    }
    api.saveAll();
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("ok", Boolean.TRUE);
    res.json(out);
  }

  private Map<String, Object> manageContext(Http.Req req, Http.Res res, boolean ownerOnly) {
    Map<String, Object> me = api.requireMeOf(req, res);
    if (me == null) return null;
    Map<String, Object> g = api.findOne("groups", "number", req.param("number"));
    if (g == null) { res.error(404, "没有这个群"); return null; }
    Map<String, Object> gm = groupMember(api.idOf(g), api.idOf(me));
    if (gm == null) { res.error(403, "你不在这个群里"); return null; }
    String role = api.strOf(gm, "role");
    boolean manager = "owner".equals(role) || "admin".equals(role);
    if (ownerOnly && !"owner".equals(role)) { res.error(403, "只有群主能操作"); return null; }
    if (!ownerOnly && !manager) { res.error(403, "只有群主和管理员能操作"); return null; }
    Map<String, Object> ctx = new LinkedHashMap<String, Object>();
    ctx.put("me", gm);
    ctx.put("group", g);
    return ctx;
  }

  private Map<String, Object> groupMember(long groupId, long accId) {
    for (Map<String, Object> m : api.findAll("group_members", "group_id", groupId)) {
      if (api.numOf(m, "account_id") == accId) return m;
    }
    return null;
  }

  private void addGroupMember(long groupId, long accId, String role) {
    if (groupMember(groupId, accId) != null) return;
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    m.put("group_id", groupId);
    m.put("account_id", accId);
    m.put("role", role);
    m.put("joined_at", System.currentTimeMillis());
    m.put("nickname", "");
    m.put("mute_until", 0);
    m.put("announcement_read_at", 0);
    api.insertRow("group_members", m);
  }

  private List<Object> membersOf(long groupId) {
    List<Object> out = new ArrayList<Object>();
    for (Map<String, Object> m : api.findAll("group_members", "group_id", groupId)) {
      Map<String, Object> a = api.accountOf(api.numOf(m, "account_id"));
      if (a == null) continue;
      Map<String, Object> item = new LinkedHashMap<String, Object>();
      String gnick = api.strOf(m, "nickname");
      item.put("number", api.strOf(a, "number"));
      item.put("nickname", gnick.isEmpty() ? api.strOf(a, "nickname") : gnick);
      item.put("group_nickname", gnick);
      item.put("bio", api.strOf(a, "bio"));
      item.put("avatar", api.strOf(a, "avatar"));
      item.put("type", api.strOf(a, "type"));
      item.put("status", api.strOf(a, "status"));
      item.put("role", api.strOf(m, "role"));
      item.put("mute_until", api.numOf(m, "mute_until"));
      item.put("joined_at", api.numOf(m, "joined_at"));
      Map<String, Object> p = api.presenceMap(api.idOf(a));
      item.put("online", p.get("online"));
      item.put("last_seen", p.get("last_seen"));
      out.add(item);
    }
    return out;
  }
}
