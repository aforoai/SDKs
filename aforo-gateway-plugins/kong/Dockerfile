# Kong with the Aforo metering plugin baked in.
#
# Why this image exists
# ---------------------
# KONG_PLUGINS is an environment variable, so changing it means recreating the
# container -- which discards anything `luarocks make` installed inside the
# previous one. Kong then refuses to boot ("aforo-metering plugin is enabled but
# not installed"), and because it dies during init_by_lua you cannot `docker exec`
# in to install it. That is a deadlock, not a flaky install. Baking the plugin
# into the image breaks it: the plugin is present before Kong ever starts.
#
#   docker build -t kong-aforo:3.4 .
#   docker run -d --name kong --network=kong-net \
#     -e KONG_DATABASE=postgres -e KONG_PG_HOST=kong-database \
#     -e KONG_PG_USER=kong -e KONG_PG_PASSWORD=kong \
#     -e KONG_ADMIN_LISTEN=0.0.0.0:8001 \
#     -p 8000:8000 -p 8001:8001 kong-aforo:3.4
#
# For a fast edit-reload loop that does not rebuild, see USER_GUIDE.md
# ("Local development: mounting the plugin from source").

FROM kong:3.4

USER root

# lua-resty-jwt cannot be installed from the LuaRocks mirrors for Lua 5.1 -- the
# manifest itself fails to load ("main function has more than 65536 constants"),
# so dependency resolution never gets as far as the package. Build from source.
#
# Tracking the default branch: pin this to a commit before using the image
# anywhere that needs reproducible builds.
RUN git clone --depth 1 https://github.com/SkyLothar/lua-resty-jwt.git /tmp/lua-resty-jwt \
    && cd /tmp/lua-resty-jwt \
    && luarocks make \
    && rm -rf /tmp/lua-resty-jwt

# `luarocks make` resolves build.modules paths relative to the working directory,
# so it must run from inside the plugin directory -- not from a parent with the
# rockspec passed as a path.
COPY . /tmp/aforo-plugin/
RUN cd /tmp/aforo-plugin \
    && luarocks make kong-plugin-aforo-metering-2.0.0-1.rockspec \
    && rm -rf /tmp/aforo-plugin

USER kong

ENV KONG_PLUGINS=bundled,aforo-metering

# handler.lua buffers events in ngx.shared.aforo_buffer. Without this dict the
# plugin loads and proxies traffic but silently meters nothing -- every log-phase
# call bails out with "Shared dict 'aforo_buffer' not found".
ENV KONG_NGINX_HTTP_LUA_SHARED_DICT="aforo_buffer 10m"
