module.exports = {
    proxy: "http://localhost:3000",
    files: ["**/*.css", "**/*.pug", "**/*.ts"],
    ignore: ["node_modules", "storage"],
    reloadDelay: 10,
    ui: false,
    notify: false,
    port: 3001,
  };