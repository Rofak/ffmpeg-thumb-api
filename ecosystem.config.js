module.exports = {
  apps: [
    {
      name: 'thumbnail-api',
      exec_mode: 'cluster',
      instances: '1', // Or a number of instances
      script: 'dist/main.js',
      args: 'start',
    },
  ],
};
